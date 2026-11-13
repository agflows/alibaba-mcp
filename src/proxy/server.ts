import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createRemoteMcp } from "./remote-mcp.js";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_HELLO_BYTES = 1024;
const HELLO_TIMEOUT_MS = 5_000;
const LONE_PEER_MS = 120_000;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_ROOMS = 500;
const PING_MS = 25_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type Role = "extension" | "agent";

type Peer = {
  role: Role;
  socket: WebSocket;
  buffer: RawData[];
  binary: boolean[];
  buffered: number;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Room = {
  extension?: Peer;
  agent?: Peer;
  loneTimer?: NodeJS.Timeout;
  pending: Map<string, PendingCall>;
};

export type ProxyHandle = {
  port: number;
  close: () => Promise<void>;
};

export function startProxy(options: { host?: string; port?: number; publicOrigin?: string } = {}): Promise<ProxyHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const rooms = new Map<string, Room>();
  let boundPort = 0;
  const remote = createRemoteMcp({
    origin: () => options.publicOrigin ?? `http://127.0.0.1:${boundPort}`,
    roomKeyForSecret: (secret) => {
      const key = createHash("sha256").update(secret).digest("hex");
      return rooms.has(key) ? key : null;
    },
    extensionReady: (roomKey) => rooms.get(roomKey)?.extension?.socket.readyState === WebSocket.OPEN,
    callExtension: (roomKey, method, params) => callExtension(rooms, roomKey, method, params),
  });
  const httpServer = createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "GET" && (path === "/health" || path.startsWith("/health?"))) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("ok\n");
      return;
    }
    void remote.handle(request, response).then((handled) => {
      if (handled || response.writableEnded) return;
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("not found\n");
    }).catch(() => {
      if (response.headersSent || response.writableEnded) return;
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("bad request\n");
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  const ping = setInterval(() => {
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, PING_MS);
  ping.unref?.();

  httpServer.on("upgrade", (request, socket, head) => {
    if (!relayPathAllowed(request)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit("connection", client);
    });
  });

  sockets.on("connection", (socket) => {
    const timer = setTimeout(() => socket.close(1008, "hello timeout"), HELLO_TIMEOUT_MS);
    const fail = (code: number, reason: string) => {
      clearTimeout(timer);
      socket.close(code, reason);
    };
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary || byteLength(data) > MAX_HELLO_BYTES) {
        fail(1008, "hello required");
        return;
      }
      const hello = parseHello(data);
      if (!hello) {
        fail(1008, "hello required");
        return;
      }
      if (rooms.size >= MAX_ROOMS && !rooms.has(hello.key)) {
        fail(1013, "busy");
        return;
      }
      join(rooms, hello.key, hello.role, socket);
    });
    socket.once("error", () => socket.close());
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Proxy failed to bind."));
        return;
      }
      boundPort = address.port;
      resolve({
        port: address.port,
        close: async () => {
          clearInterval(ping);
          for (const room of rooms.values()) closeRoom(room);
          rooms.clear();
          for (const client of sockets.clients) client.close(1001, "proxy closed");
          sockets.close();
          await new Promise<void>((done) => httpServer.close(() => done()));
        },
      });
    });
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.split(path.sep).join("/");
  return normalized.endsWith("/server.cjs") || normalized.endsWith("/proxy/server.js");
}

function relayPathAllowed(request: IncomingMessage): boolean {
  try {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    return url.pathname === "/relay" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function parseHello(data: RawData): { key: string; role: Role } | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(rawToString(data)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const token = typeof record.token === "string" ? record.token : "";
  if (record.type !== "proxy-hello" || !TOKEN_PATTERN.test(token)) return null;
  if (record.role !== "extension" && record.role !== "agent") return null;
  return { key: createHash("sha256").update(token).digest("hex"), role: record.role };
}

function join(rooms: Map<string, Room>, key: string, role: Role, socket: WebSocket): void {
  let room = rooms.get(key);
  if (!room) {
    room = { pending: new Map() };
    rooms.set(key, room);
  }
  const previous = room[role];
  if (previous && previous.socket !== socket) previous.socket.close(4000, "replaced");
  const peer: Peer = { role, socket, buffer: [], binary: [], buffered: 0 };
  room[role] = peer;
  const otherRole: Role = role === "extension" ? "agent" : "extension";
  socket.on("message", (data, isBinary) => {
    const current = room[role];
    if (current?.socket !== socket) return;
    if (role === "extension" && !isBinary && takePending(room, data)) return;
    if (role === "extension" && !isBinary && !room.agent && isPing(data)) {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    const other = room[role === "extension" ? "agent" : "extension"];
    if (!other || other.socket.readyState !== WebSocket.OPEN) {
      const size = byteLength(data);
      if (peer.buffered + size > MAX_BUFFER_BYTES) {
        socket.close(1009, "buffer full");
        return;
      }
      peer.buffer.push(data);
      peer.binary.push(isBinary);
      peer.buffered += size;
      return;
    }
    other.socket.send(data, { binary: isBinary });
  });
  socket.on("close", () => {
    if (room[role]?.socket !== socket) return;
    delete room[role];
    if (role === "extension") rejectPending(room, new Error("The Alibaba browser disconnected."));
    const other = room[otherRole];
    if (other) {
      delete room[otherRole];
      other.socket.close(1001, "peer closed");
    }
    clearTimeout(room.loneTimer);
    if (!room.extension && !room.agent) rooms.delete(key);
  });
  socket.on("error", () => socket.close());
  flush(room[otherRole], socket);
  if (room.extension && room.agent) clearTimeout(room.loneTimer);
  else if (room.agent) armLoneTimer(rooms, key, room);
  else clearTimeout(room.loneTimer);
}

function flush(from: Peer | undefined, to: WebSocket): void {
  if (!from || to.readyState !== WebSocket.OPEN) return;
  for (let index = 0; index < from.buffer.length; index += 1) {
    const data = from.buffer[index];
    const binary = from.binary[index];
    if (data === undefined || binary === undefined) continue;
    to.send(data, { binary });
  }
  from.buffer = [];
  from.binary = [];
  from.buffered = 0;
}

function armLoneTimer(rooms: Map<string, Room>, key: string, room: Room): void {
  clearTimeout(room.loneTimer);
  room.loneTimer = setTimeout(() => {
    if (room.extension && room.agent) return;
    closeRoom(room);
    rooms.delete(key);
  }, LONE_PEER_MS);
  room.loneTimer.unref?.();
}

function closeRoom(room: Room): void {
  clearTimeout(room.loneTimer);
  rejectPending(room, new Error("The Alibaba browser disconnected."));
  room.extension?.socket.close(1001, "relay closed");
  room.agent?.socket.close(1001, "relay closed");
}

function callExtension(
  rooms: Map<string, Room>,
  roomKey: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const room = rooms.get(roomKey);
  const socket = room?.extension?.socket;
  if (!room || !socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("The Alibaba browser is not connected. Open the messenger tab."));
  }
  const id = `mcp_${randomUUID()}`;
  const timeout = method === "get_conversation" || method === "send_message" ? 45_000 : 20_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.pending.delete(id);
      reject(new Error(`Timed out waiting for the Alibaba tab while running ${method}.`));
    }, timeout);
    timer.unref?.();
    room.pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), (error) => {
      if (!error) return;
      clearTimeout(timer);
      room.pending.delete(id);
      reject(new Error("The Alibaba browser connection failed."));
    });
  });
}

function takePending(room: Room, data: RawData): boolean {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(rawToString(data)) as Record<string, unknown>;
  } catch {
    return false;
  }
  const id = typeof record.id === "string" ? record.id : "";
  const pending = id.startsWith("mcp_") ? room.pending.get(id) : undefined;
  if (!pending) return false;
  clearTimeout(pending.timer);
  room.pending.delete(id);
  if (record.ok === true) pending.resolve(record.result);
  else pending.reject(new Error(typeof record.error === "string" ? record.error.slice(0, 300) : "Alibaba request failed."));
  return true;
}

function rejectPending(room: Room, error: Error): void {
  for (const pending of room.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  room.pending.clear();
}

function isPing(data: RawData): boolean {
  try {
    const record = JSON.parse(rawToString(data)) as { type?: unknown };
    return record.type === "ping";
  } catch {
    return false;
  }
}

function configuredOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("PUBLIC_ORIGIN must be an origin.");
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("PUBLIC_ORIGIN must use https.");
  }
  return url.origin;
}

function byteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((sum, item) => sum + item.length, 0);
  return data.byteLength;
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

const invokedDirectly = isDirectRun();
if (invokedDirectly) {
  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("alibaba-mcp-proxy: PORT must be an integer from 1 to 65535.");
    process.exit(1);
  }
  const origin = configuredOrigin(process.env.PUBLIC_ORIGIN?.trim() || "https://alibaba-mcp-proxy.leogruetzner.com");
  startProxy({ host, port, publicOrigin: origin })
    .then((proxy) => {
      console.error(`alibaba-mcp-proxy listening on ${host}:${proxy.port}`);
      const stop = () => {
        void proxy.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "failed to start";
      console.error(`alibaba-mcp-proxy: ${message}`);
      process.exit(1);
    });
}
