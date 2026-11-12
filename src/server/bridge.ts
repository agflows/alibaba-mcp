import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { authProof, BridgeConfigError, isLoopbackAddress, proofsMatch } from "./auth.js";
import {
  ATTACHMENT_CANCELLED,
  ATTACHMENT_FAILED,
  ATTACHMENT_TOO_LARGE,
  MAX_ATTACHMENT_BYTES,
  decodeChunkFrame,
  redactSensitive,
  safeAgentError,
  safeContentType,
  sanitizeFileName,
} from "../shared/attachments.js";
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  isBridgeMethod,
  extensionOrigin,
  isValidExtensionId,
  isValidPairingToken,
  type BridgeMethod,
} from "../shared/protocol.js";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_ERROR_LENGTH = 1000;
const MAX_PENDING = 20;
const DOWNLOAD_STALL_MS = 20_000;
const DOWNLOAD_MAX_MS = 10 * 60 * 1000;

export interface ExtensionBridgeOptions {
  token: string;
  extensionIds: string[];
  port?: number;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  claimPairing?: () => Promise<boolean>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DownloadStart {
  name: string;
  contentType?: string;
  byteSize?: number;
}

export interface DownloadSink {
  start(meta: DownloadStart): void | Promise<void>;
  chunk(offset: number, data: Uint8Array): void | Promise<void>;
  end(byteSize: number): void | Promise<void>;
}

interface DownloadSession {
  sink: DownloadSink;
  maxBytes: number;
  received: number;
  started: boolean;
  failed: boolean;
  tail: Promise<void>;
  timer: NodeJS.Timeout;
  stallMs: number;
  startedAt: number;
  maxDurationMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ExtensionBridge {
  readonly ready: Promise<void>;
  private readonly server: WebSocketServer;
  private readonly token: string;
  private readonly extensionOrigins: Set<string>;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly claimPairing: () => Promise<boolean>;
  private extension: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private closed = false;
  private pending = new Map<string, PendingCall>();
  private downloads = new Map<string, DownloadSession>();

  constructor(options: ExtensionBridgeOptions) {
    if (!isValidPairingToken(options.token)) {
      throw new BridgeConfigError("Pairing token is missing or too weak.");
    }
    if (!options.extensionIds.length || options.extensionIds.some((id) => !isValidExtensionId(id))) {
      throw new BridgeConfigError("At least one valid Chrome extension id is required.");
    }
    const port = options.port ?? BRIDGE_PORT;
    if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
      throw new BridgeConfigError("Bridge port must be an integer from 1024 to 65535, or 0 for an ephemeral test port.");
    }

    this.token = options.token;
    this.extensionOrigins = new Set(options.extensionIds.map(extensionOrigin));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.staleAfterMs = options.staleAfterMs ?? 45_000;
    let pairingAvailable = true;
    this.claimPairing = options.claimPairing ?? (async () => {
      if (!pairingAvailable) return false;
      pairingAvailable = false;
      return true;
    });
    this.server = new WebSocketServer({
      host: BRIDGE_HOST,
      port,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
      verifyClient: ({ req }: { origin: string; secure: boolean; req: IncomingMessage }) =>
        this.handshakeAllowed(req),
    });

    this.server.on("connection", (socket, request) => {
      if (this.closed || !this.handshakeAllowed(request)) {
        socket.close(1008, "rejected");
        return;
      }
      this.authenticate(socket);
    });

    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.server.once("listening", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      this.server.on("error", (error: NodeJS.ErrnoException) => {
        const message =
          error.code === "EADDRINUSE"
            ? `localhost port ${port} is already in use. Close the other alibaba-mcp process and retry.`
            : `Bridge failed: ${error.message}`;
        if (settled) {
          console.error(`alibaba-mcp: ${message}`);
          return;
        }
        settled = true;
        reject(new Error(message));
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string") return 0;
    return address.port;
  }

  get host(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") return "";
    return address.address;
  }

  get connected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  sanitize(message: string): string {
    return redactSensitive(message.split(this.token).join("[redacted]"));
  }

  async call(method: BridgeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "download_attachment") throw new Error("Attachment downloads use the streaming path.");
    if (!isBridgeMethod(method)) throw new Error("Unsupported Alibaba operation.");
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Alibaba extension is not connected. Open Chrome, enable alibaba-mcp, and keep https://message.alibaba.com/ open.",
      );
    }
    if (this.lastActivity > 0 && Date.now() - this.lastActivity > this.staleAfterMs) {
      this.drop(socket, "Alibaba extension connection went stale. It will reconnect automatically.");
      throw new Error("Alibaba extension connection went stale. It will reconnect automatically.");
    }
    if (this.pending.size >= MAX_PENDING) {
      throw new Error("Too many Alibaba requests are already waiting.");
    }

    const id = crypto.randomUUID();
    const request = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for the Alibaba tab while running ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(request), (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new Error("Alibaba extension connection failed while sending the request."));
        });
      } catch {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error("Alibaba extension connection failed while sending the request."));
      }
    });
  }

  async download(
    params: { conversationId: string; attachmentId: string },
    sink: DownloadSink,
    options: { signal?: AbortSignal; maxBytes?: number; stallMs?: number; maxDurationMs?: number } = {},
  ): Promise<void> {
    const socket = this.requireSocket();
    if (options.signal?.aborted) throw new Error(ATTACHMENT_CANCELLED);
    if (this.downloads.size >= 2) throw new Error("Another attachment download is still running.");
    const id = crypto.randomUUID();
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
    const maxDurationMs = options.maxDurationMs ?? DOWNLOAD_MAX_MS;

    await new Promise<void>((resolve, reject) => {
      const session: DownloadSession = {
        sink,
        maxBytes,
        received: 0,
        started: false,
        failed: false,
        tail: Promise.resolve(),
        timer: setTimeout(() => this.failDownload(id, "Attachment download timed out.", true), stallMs),
        stallMs,
        startedAt: Date.now(),
        maxDurationMs,
        resolve,
        reject,
        signal: options.signal,
      };
      session.onAbort = () => this.failDownload(id, ATTACHMENT_CANCELLED, true);
      options.signal?.addEventListener("abort", session.onAbort, { once: true });
      this.downloads.set(id, session);
      try {
        socket.send(JSON.stringify({ id, method: "download_attachment", params }), (error) => {
          if (error) this.failDownload(id, "Alibaba extension connection failed while sending the request.", false);
        });
      } catch {
        this.failDownload(id, "Alibaba extension connection failed while sending the request.", false);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    this.failPending("Alibaba MCP bridge closed.");
    this.failAllDownloads("Alibaba MCP bridge closed.");
    const current = this.extension;
    this.extension = null;
    if (current && current.readyState !== WebSocket.CLOSED) current.close(1001, "bridge closed");
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handshakeAllowed(req: IncomingMessage): boolean {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
    if (typeof req.headers.origin !== "string" || !this.extensionOrigins.has(req.headers.origin)) return false;
    const raw = req.url;
    if (!raw || raw.length > MAX_URL_LENGTH) return false;
    try {
      const url = new URL(raw, `http://${BRIDGE_HOST}`);
      return url.pathname === "/" && url.search === "" && url.hash === "";
    } catch {
      return false;
    }
  }

  private authenticate(socket: WebSocket): void {
    const challenge = randomBytes(32).toString("base64url");
    const timer = setTimeout(() => socket.close(1008, "authentication timeout"), 5_000);
    const finish = () => clearTimeout(timer);
    socket.once("close", finish);
    socket.once("error", finish);
    socket.once("message", async (data, isBinary) => {
      if (isBinary) return socket.close(1008, "authentication required");
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(rawToString(data)) as Record<string, unknown>;
      } catch {
        return socket.close(1008, "authentication required");
      }
      if (record.type === "pair-request") {
        finish();
        let claimed = false;
        try {
          claimed = await this.claimPairing();
        } catch {
          socket.close(1011, "pairing state failed");
          return;
        }
        if (!claimed) {
          socket.send(JSON.stringify({ type: "pairing-unavailable" }), () => socket.close(1008, "pairing unavailable"));
          return;
        }
        socket.send(JSON.stringify({ type: "pair-token", token: this.token }), () => socket.close(1000, "paired"));
        return;
      }
      const proof = typeof record.proof === "string" ? record.proof : "";
      if (record.type !== "auth-proof" || !proofsMatch(authProof(this.token, challenge), proof)) {
        finish();
        socket.send(JSON.stringify({ type: "pairing-required" }), () => socket.close(1008, "pairing required"));
        return;
      }
      finish();
      socket.send(JSON.stringify({ type: "auth-ok" }));
      this.adopt(socket);
    });
    socket.send(JSON.stringify({ type: "auth-challenge", challenge }));
  }

  private adopt(socket: WebSocket): void {
    const previous = this.extension;
    if (previous && previous !== socket) {
      this.extension = null;
      this.clearHeartbeat();
      this.failPending("Alibaba extension reconnected. Retry the request.");
      this.failAllDownloads("Alibaba extension reconnected. Retry the request.");
      previous.close(1012, "replaced");
    }
    this.extension = socket;
    this.noteActivity();
    this.armHeartbeat(socket);
    socket.on("message", (data, isBinary) => {
      if (this.extension !== socket) return;
      this.noteActivity();
      if (isBinary) {
        this.onBinary(socket, data);
        return;
      }
      this.onText(socket, data);
    });
    socket.on("pong", () => {
      if (this.extension === socket) this.noteActivity();
    });
    socket.on("close", () => {
      if (this.extension !== socket) return;
      this.clearHeartbeat();
      this.extension = null;
      this.failPending("Alibaba extension disconnected.");
      this.failAllDownloads("Alibaba extension disconnected.");
    });
    socket.on("error", () => {
      if (this.extension === socket) socket.close();
    });
  }

  private requireSocket(): WebSocket {
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Alibaba extension is not connected. Open Chrome, enable alibaba-mcp, and keep https://message.alibaba.com/ open.",
      );
    }
    if (this.lastActivity > 0 && Date.now() - this.lastActivity > this.staleAfterMs) {
      this.drop(socket, "Alibaba extension connection went stale. It will reconnect automatically.");
      throw new Error("Alibaba extension connection went stale. It will reconnect automatically.");
    }
    return socket;
  }

  private onText(socket: WebSocket, raw: RawData): void {
    const text = rawToString(raw);
    if (text.length > MAX_PAYLOAD_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "ping") {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (typeof record.id !== "string") return;
    if (this.downloads.has(record.id)) {
      this.onDownloadControl(record.id, record);
      return;
    }
    const pending = this.pending.get(record.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(record.id);
    if (record.ok === true) {
      pending.resolve(record.result);
      return;
    }
    const error = typeof record.error === "string" ? record.error.slice(0, MAX_ERROR_LENGTH) : "Alibaba extension request failed.";
    pending.reject(new Error(this.sanitize(error)));
  }

  private onDownloadControl(id: string, record: Record<string, unknown>): void {
    const session = this.downloads.get(id);
    if (!session || session.failed) return;
    if (!this.touchDownload(session, id)) return;
    if (record.ok === false || record.type === "download-error") {
      const error = typeof record.error === "string" ? record.error : ATTACHMENT_FAILED;
      this.failDownload(id, safeAgentError(error), false);
      return;
    }
    if (record.type === "download-start") {
      const contentType = safeContentType(record.contentType);
      const byteSize = typeof record.byteSize === "number" && Number.isFinite(record.byteSize) ? Math.floor(record.byteSize) : undefined;
      if (byteSize !== undefined && byteSize > session.maxBytes) {
        this.failDownload(id, ATTACHMENT_TOO_LARGE, true);
        return;
      }
      session.started = true;
      session.tail = session.tail
        .then(async () => {
          if (session.failed) return;
          await session.sink.start({
            name: sanitizeFileName(record.name),
            ...(contentType ? { contentType } : {}),
            ...(byteSize === undefined ? {} : { byteSize }),
          });
        })
        .catch((error: unknown) => {
          this.failDownload(id, error instanceof Error ? error.message : ATTACHMENT_FAILED, true);
        });
      return;
    }
    if (record.type === "download-end") {
      const byteSize = typeof record.byteSize === "number" ? record.byteSize : session.received;
      session.tail = session.tail
        .then(async () => {
          if (session.failed) return;
          if (!session.started || byteSize !== session.received) throw new Error(ATTACHMENT_FAILED);
          await session.sink.end(byteSize);
          if (session.failed) return;
          clearTimeout(session.timer);
          this.downloads.delete(id);
          session.signal?.removeEventListener("abort", session.onAbort ?? (() => {}));
          session.resolve();
        })
        .catch((error: unknown) => {
          this.failDownload(id, error instanceof Error ? error.message : ATTACHMENT_FAILED, true);
        });
    }
  }

  private onBinary(socket: WebSocket, raw: RawData): void {
    const frame = decodeChunkFrame(toBytes(raw));
    if (!frame) return;
    const session = this.downloads.get(frame.id);
    if (!session || session.failed) return;
    if (!this.touchDownload(session, frame.id)) return;
    if (!session.started || frame.offset !== session.received) {
      this.failDownload(frame.id, ATTACHMENT_FAILED, true);
      return;
    }
    if (session.received + frame.data.byteLength > session.maxBytes) {
      this.failDownload(frame.id, ATTACHMENT_TOO_LARGE, true);
      return;
    }
    const data = frame.data;
    session.received += data.byteLength;
    socket.pause();
    session.tail = session.tail
      .then(async () => {
        if (session.failed) return;
        await session.sink.chunk(frame.offset, data);
      })
      .then(() => {
        if (this.extension === socket && socket.readyState === WebSocket.OPEN) socket.resume();
      })
      .catch((error: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.resume();
        this.failDownload(frame.id, error instanceof Error ? error.message : ATTACHMENT_FAILED, true);
      });
  }

  private touchDownload(session: DownloadSession, id: string): boolean {
    if (Date.now() - session.startedAt > session.maxDurationMs) {
      this.failDownload(id, "Attachment download timed out.", true);
      return false;
    }
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.failDownload(id, "Attachment download timed out.", true), session.stallMs);
    return true;
  }

  private failDownload(id: string, message: string, notify: boolean): void {
    const session = this.downloads.get(id);
    if (!session || session.failed) return;
    session.failed = true;
    clearTimeout(session.timer);
    this.downloads.delete(id);
    if (session.onAbort) session.signal?.removeEventListener("abort", session.onAbort);
    if (notify) this.sendJson({ id, type: "download-cancel" });
    session.reject(new Error(this.sanitize(safeAgentError(message))));
  }

  private failAllDownloads(message: string): void {
    for (const id of [...this.downloads.keys()]) this.failDownload(id, message, false);
  }

  private sendJson(message: Record<string, unknown>): void {
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private armHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.extension !== socket) return;
      if (Date.now() - this.lastActivity > this.staleAfterMs) {
        socket.terminate();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, this.heartbeatMs);
  }

  private noteActivity(): void {
    this.lastActivity = Date.now();
  }

  private clearHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private drop(socket: WebSocket, message: string): void {
    if (this.extension === socket) {
      this.extension = null;
      this.clearHeartbeat();
    }
    this.failPending(message);
    this.failAllDownloads(message);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

function toBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return new Uint8Array(Buffer.from(raw));
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}
