export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 17873;
export const BRIDGE_URL = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const DEFAULT_ACCESS: AccessMode = "write";
export const PAIRING_TOKEN_BYTES = 32;

export const SEND_APPROVAL_INSTRUCTION =
  "Get the user's explicit approval before sending. Show the exact conversation and the exact message text, wait for a clear yes, and only then call alibaba_send_message. Do not send, rewrite-and-send, or retry a send without a new approval.";

export const AGENT_INSTRUCTIONS = [
  "alibaba-mcp is a fully local bridge between this agent and the user's Chrome tab at https://message.alibaba.com/.",
  "The Alibaba session stays in Chrome. Do not ask for cookies, passwords, or session tokens.",
  "Call alibaba_status first.",
  "Access is exactly one of none, read, or read/write. The extension enforces it. The default is read/write.",
  SEND_APPROVAL_INSTRUCTION,
  "If the extension is disconnected, ask the user to open alibaba-mcp and keep the Alibaba tab open.",
  "Attachment files are saved in a private local cache. Never ask for, display, or store Alibaba download URLs or signed links. Use alibaba_list_attachments and alibaba_download_attachment. A download result is a local file path.",
].join("\n");

export type AccessMode = "none" | "read" | "write";

export type BridgeMethod =
  | "get_status"
  | "list_conversations"
  | "get_conversation"
  | "send_message"
  | "list_attachments"
  | "download_attachment";

export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface BridgeCommand {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  unread: boolean;
  timestamp?: string;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  timestamp?: string;
  direction: "incoming" | "outgoing" | "unknown";
}

export interface ConversationDetail {
  id: string;
  title: string;
  messages: ChatMessage[];
}

const BRIDGE_METHODS = new Set<BridgeMethod>([
  "get_status",
  "list_conversations",
  "get_conversation",
  "send_message",
  "list_attachments",
  "download_attachment",
]);

const READ_METHODS = new Set<string>([
  "list_conversations",
  "get_conversation",
  "list_attachments",
  "download_attachment",
]);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function canRead(mode: AccessMode): boolean {
  return mode === "read" || mode === "write";
}

export function canWrite(mode: AccessMode): boolean {
  return mode === "write";
}

export function normalizeAccessMode(value: unknown): AccessMode | null {
  return value === "none" || value === "read" || value === "write" ? value : null;
}

export function accessError(mode: AccessMode, method: string): string | null {
  if (method === "get_status") return null;
  if (READ_METHODS.has(method)) {
    return canRead(mode) ? null : "Chat access is disabled. Change it in the alibaba-mcp extension.";
  }
  if (method === "send_message") {
    return canWrite(mode) ? null : "Sending is disabled. Set chat access to Read & write in alibaba-mcp.";
  }
  return "Unsupported Alibaba operation.";
}

export function isBridgeMethod(method: string): method is BridgeMethod {
  return BRIDGE_METHODS.has(method as BridgeMethod);
}

export function isValidPairingToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function isValidExtensionId(extensionId: string): boolean {
  return EXTENSION_ID_PATTERN.test(extensionId);
}

export function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

export function isExactExtensionOrigin(origin: unknown, extensionId: string): boolean {
  return typeof origin === "string" && isValidExtensionId(extensionId) && origin === extensionOrigin(extensionId);
}

export function createPairingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function safePageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== "https://message.alibaba.com") return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function isBridgePong(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "pong");
}

export function parseIncomingCommand(value: unknown): BridgeCommand | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length < 1 || record.id.length > 100) return null;
  if (typeof record.method !== "string" || record.method.length < 1 || record.method.length > 80) return null;
  const params = record.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  return { id: record.id, method: record.method, params: params as Record<string, unknown> };
}

export function isExtensionUiSender(sender: { id?: string; url?: string }, extensionId: string): boolean {
  if (!sender.id || sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === extensionId;
  } catch {
    return false;
  }
}

export function formatAgentSetup(input: { token: string; extensionId: string; serverPath?: string }): string {
  const serverPath = input.serverPath ?? "<PATH-TO-alibaba-mcp>/dist/server/index.js";
  const config = {
    mcpServers: {
      alibaba: {
        command: "node",
        args: [serverPath],
        env: {
          ALIBABA_MCP_TOKEN: input.token,
          ALIBABA_MCP_EXTENSION_ID: input.extensionId,
        },
      },
    },
  };
  return [
    "Add this local MCP server to your agent configuration.",
    "Replace <PATH-TO-alibaba-mcp> with the absolute path of your private checkout.",
    "Keep the pairing token secret. Do not commit it, log it, or paste it into a chat.",
    "",
    JSON.stringify(config, null, 2),
    "",
    "Keep a logged-in https://message.alibaba.com/ tab open in Chrome.",
    "Use alibaba_status first.",
    "Attachment downloads are local files. Do not ask for or display Alibaba download URLs.",
    SEND_APPROVAL_INSTRUCTION,
  ].join("\n");
}
