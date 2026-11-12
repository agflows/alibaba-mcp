import {
  isDownloadCancel,
  publicAttachmentList,
  readAttachmentId,
  readOpaqueId,
  safeAgentError,
} from "../shared/attachments.js";
import { streamAttachment } from "./download.js";
import {
  BRIDGE_URL,
  DEFAULT_ACCESS,
  accessError,
  canRead,
  canWrite,
  createPairingToken,
  isBridgePong,
  isExtensionUiSender,
  isValidPairingToken,
  normalizeAccessMode,
  parseIncomingCommand,
  safePageUrl,
  type AccessMode,
  type BridgeCommand,
  type BridgeResponse,
} from "../shared/protocol.js";
import {
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_MS,
  KEEPALIVE_ALARM,
  KEEPALIVE_PERIOD_MINUTES,
  PONG_TIMEOUT_MS,
  RECONNECT_MIN_MS,
  nextReconnectDelay,
} from "./reconnect.js";

let accessMode: AccessMode = DEFAULT_ACCESS;
let bridgeToken = "";
let socket: WebSocket | null = null;
let socketGeneration = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let pongWatchdog: ReturnType<typeof setTimeout> | undefined;
let connectWatchdog: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let bridgeConnected = false;
let bootPromise: Promise<void> | null = null;
const downloads = new Map<string, AbortController>();

chrome.runtime.onInstalled.addListener(() => {
  void boot();
});

chrome.runtime.onStartup.addListener(() => {
  void boot();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void boot();
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url?.startsWith("https://message.alibaba.com/")) return;
  void boot();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionUiSender(sender, chrome.runtime.id)) return;
  if (message?.type === "get-config") {
    void boot().then(() => {
      sendResponse({
        accessMode,
        bridgeConnected,
        bridgeToken,
        extensionId: chrome.runtime.id,
      });
    });
    return true;
  }
  if (message?.type === "set-access") {
    void boot().then(() => {
      const next = normalizeAccessMode(message.accessMode);
      if (!next) {
        sendResponse({ ok: false, error: "Invalid access mode." });
        return;
      }
      accessMode = next;
      void chrome.storage.local.set({ accessMode });
      sendResponse({ ok: true, accessMode });
    });
    return true;
  }
  if (message?.type === "copy-conversation") {
    void boot()
      .then(async () => {
        if (!canRead(accessMode)) throw new Error("Set chat access to Read or Read & write first.");
        const page = await askTab("get_page_status", {});
        const selectedConversationId =
          page && typeof page === "object" && typeof (page as { selectedConversationId?: unknown }).selectedConversationId === "string"
            ? (page as { selectedConversationId: string }).selectedConversationId
            : "";
        if (!selectedConversationId) throw new Error("Select an Alibaba conversation first.");
        const conversation = await askTab("get_conversation", { conversationId: selectedConversationId, limit: 500 });
        sendResponse({ ok: true, conversation });
      })
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: publicError(error) });
      });
    return true;
  }
  if (message?.type === "rotate-token") {
    void boot().then(async () => {
      bridgeToken = createPairingToken();
      await chrome.storage.local.set({ bridgeToken });
      reconnectNow();
      sendResponse({ ok: true, bridgeToken });
    });
    return true;
  }
  return;
});

void boot();

function boot(): Promise<void> {
  if (!bootPromise) {
    bootPromise = start().catch((error: unknown) => {
      bootPromise = null;
      console.error("alibaba-mcp: background startup failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return bootPromise.then(() => {
    ensureConnected();
  });
}

async function start(): Promise<void> {
  await loadConfig();
  await ensureAlarm();
  ensureConnected();
}

async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get({ accessMode: null, bridgeToken: "" });
  if (stored.accessMode == null) {
    accessMode = DEFAULT_ACCESS;
    await chrome.storage.local.set({ accessMode });
  } else {
    const normalized = normalizeAccessMode(stored.accessMode);
    accessMode = normalized ?? "none";
    if (!normalized) await chrome.storage.local.set({ accessMode: "none" });
  }
  const storedToken = typeof stored.bridgeToken === "string" ? stored.bridgeToken : "";
  if (isValidPairingToken(storedToken)) {
    bridgeToken = storedToken;
    return;
  }
  bridgeToken = createPairingToken();
  await chrome.storage.local.set({ bridgeToken });
}

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (existing) return;
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
}

function ensureConnected(): void {
  if (!isValidPairingToken(bridgeToken)) return;
  if (socket?.readyState === WebSocket.OPEN) {
    sendPing(socketGeneration, socket);
    return;
  }
  if (socket?.readyState === WebSocket.CONNECTING) return;
  connect();
}

function reconnectNow(): void {
  reconnectDelay = RECONNECT_MIN_MS;
  clearTimeout(reconnectTimer);
  retireSocket();
  connect();
}

function retireSocket(): void {
  socketGeneration += 1;
  bridgeConnected = false;
  clearSocketTimers();
  abortDownloads();
  const current = socket;
  socket = null;
  if (current && current.readyState !== WebSocket.CLOSED) current.close();
}

function abortDownloads(): void {
  for (const controller of downloads.values()) controller.abort();
  downloads.clear();
}

function clearSocketTimers(): void {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(pongWatchdog);
  clearTimeout(connectWatchdog);
  reconnectTimer = undefined;
  heartbeatTimer = undefined;
  pongWatchdog = undefined;
  connectWatchdog = undefined;
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = nextReconnectDelay(reconnectDelay);
  reconnectTimer = setTimeout(() => connect(), delay);
}

function connect(): void {
  if (!isValidPairingToken(bridgeToken)) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const generation = ++socketGeneration;
  const url = new URL(BRIDGE_URL);
  url.pathname = "/";
  url.searchParams.set("token", bridgeToken);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url.toString());
  } catch (error) {
    console.error("alibaba-mcp: websocket open failed:", error instanceof Error ? error.message : String(error));
    scheduleReconnect();
    return;
  }
  socket = ws;
  connectWatchdog = setTimeout(() => {
    if (generation === socketGeneration && ws.readyState === WebSocket.CONNECTING) ws.close();
  }, CONNECT_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    if (generation !== socketGeneration) {
      ws.close();
      return;
    }
    bridgeConnected = true;
    reconnectDelay = RECONNECT_MIN_MS;
    clearTimeout(connectWatchdog);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => sendPing(generation, ws), HEARTBEAT_MS);
  });

  ws.addEventListener("message", (event) => {
    if (generation !== socketGeneration) return;
    void onSocketMessage(generation, ws, event.data);
  });

  ws.addEventListener("close", () => {
    if (generation !== socketGeneration) return;
    abortDownloads();
    bridgeConnected = false;
    if (socket === ws) socket = null;
    clearInterval(heartbeatTimer);
    clearTimeout(pongWatchdog);
    clearTimeout(connectWatchdog);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    if (generation !== socketGeneration) return;
    ws.close();
  });
}

function sendPing(generation: number, ws: WebSocket): void {
  if (generation !== socketGeneration || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "ping" }));
  clearTimeout(pongWatchdog);
  pongWatchdog = setTimeout(() => {
    if (generation !== socketGeneration) return;
    ws.close();
  }, PONG_TIMEOUT_MS);
}

async function onSocketMessage(generation: number, ws: WebSocket, data: unknown): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  if (isBridgePong(message)) {
    clearTimeout(pongWatchdog);
    return;
  }
  if (isDownloadCancel(message)) {
    downloads.get(message.id)?.abort();
    return;
  }
  const command = parseIncomingCommand(message);
  if (!command) return;
  if (command.method === "download_attachment") {
    await runDownload(command, generation, ws);
    return;
  }
  const response = await handleRequest(command);
  if (generation !== socketGeneration || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(response));
}

function sendBridge(ws: WebSocket, generation: number, message: Record<string, unknown>): void {
  if (generation !== socketGeneration || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

async function handleRequest(request: BridgeCommand): Promise<BridgeResponse> {
  try {
    const denied = accessError(accessMode, request.method);
    if (denied) throw new Error(denied);
    if (request.method === "get_status") {
      return { id: request.id, ok: true, result: await statusResult() };
    }
    if (request.method === "download_attachment") {
      throw new Error("Attachment downloads use the streaming path.");
    }
    if (request.method === "list_attachments") {
      const conversationId = readOpaqueId(request.params.conversationId, "Conversation id");
      const listed = publicAttachmentList(await askTab("list_attachments", { conversationId }));
      const limit = clampLimit(request.params.limit);
      return { id: request.id, ok: true, result: { attachments: listed.attachments.slice(0, limit) } };
    }
    return { id: request.id, ok: true, result: await askTab(request.method, request.params) };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: publicError(error),
    };
  }
}

async function runDownload(request: BridgeCommand, generation: number, ws: WebSocket): Promise<void> {
  const denied = accessError(accessMode, request.method);
  if (denied) {
    sendBridge(ws, generation, { id: request.id, ok: false, error: denied });
    return;
  }
  if (downloads.size >= 2) {
    sendBridge(ws, generation, { id: request.id, ok: false, error: "Another attachment download is still running." });
    return;
  }
  let conversationId = "";
  let attachmentId = "";
  try {
    conversationId = readOpaqueId(request.params.conversationId, "Conversation id");
    attachmentId = readAttachmentId(request.params.attachmentId);
  } catch (error) {
    sendBridge(ws, generation, { id: request.id, ok: false, error: publicError(error) });
    return;
  }
  const controller = new AbortController();
  downloads.set(request.id, controller);
  try {
    await streamAttachment({
      id: request.id,
      signal: controller.signal,
      prepare: () => askTab("prepare_attachment", { conversationId, attachmentId }),
      sendJson: (message) => sendBridge(ws, generation, message),
      sendBinary: (frame) => {
        if (generation !== socketGeneration || ws.readyState !== WebSocket.OPEN) return;
        ws.send(frame);
      },
    });
  } finally {
    downloads.delete(request.id);
  }
}

async function askTab(method: string, params: Record<string, unknown>): Promise<unknown> {
  const tab = await getAlibabaTab();
  if (!tab?.id) throw new Error("Open https://message.alibaba.com/ in a logged-in Chrome tab.");
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: "alibaba-mcp-request",
    method,
    params,
  });
  if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "Alibaba page request failed.");
  return result.result;
}

function clampLimit(value: unknown): number {
  if (value == null) return 50;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer from 1 to 100.");
  }
  return value;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Alibaba page request failed.";
  if (/clouddisk\.alibaba\.com|aliyuncs\.com/i.test(message) || /downloadUrl|signature=|ossaccesskeyid=|security-token=/i.test(message)) {
    return safeAgentError(message);
  }
  return message.slice(0, 500);
}

async function statusResult(): Promise<Record<string, unknown>> {
  const tab = await getAlibabaTab();
  const result: Record<string, unknown> = {
    extensionConnected: true,
    accessMode,
    canRead: canRead(accessMode),
    canWrite: canWrite(accessMode),
    alibabaTabOpen: Boolean(tab),
  };
  if (!canRead(accessMode) || !tab?.id) return result;
  if (tab.url) result.tabUrl = safePageUrl(tab.url);
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "alibaba-mcp-request",
      method: "get_page_status",
      params: {},
    });
    result.page = response?.ok ? pageDiagnostics(response.result) : { error: response?.error };
  } catch (error) {
    result.page = { error: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

function pageDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const page = { ...(value as Record<string, unknown>) };
  delete page.href;
  delete page.downloadUrl;
  return page;
}

async function getAlibabaTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: "https://message.alibaba.com/*" });
  return tabs.find((tab) => tab.active) ?? tabs[0];
}
