export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const ATTACHMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_HOST = "clouddisk.alibaba.com";
export const OSS_APEX = "aliyuncs.com";
const INITIAL_URL_MAX = 2_000;
const REDIRECT_URL_MAX = 16_384;
const BUCKET_LABEL = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const OSS_SERVICE_LABEL = /^oss(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export const ATTACHMENT_TOO_LARGE = "Attachment exceeds the size limit.";
export const ATTACHMENT_HOST_DENIED = "Attachment host is not allowed.";
export const ATTACHMENT_FAILED = "Attachment download failed.";
export const ATTACHMENT_CANCELLED = "Attachment download was cancelled.";
export const ATTACHMENT_UNAVAILABLE = "Attachment support is not available in this page yet.";

const FRAME_MAGIC = 0xa1;
const FRAME_VERSION = 1;
const FRAME_CHUNK = 1;

export interface PublicAttachment {
  id: string;
  messageId?: string;
  name: string;
  byteSize?: number;
  contentType?: string;
}

export interface PreparedAttachment {
  url: string;
  name: string;
  byteSize?: number;
  contentType?: string;
}

export interface ChunkFrame {
  id: string;
  offset: number;
  data: Uint8Array;
}

export function sanitizeFileName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const base = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned;
}

export function safeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(type)) return undefined;
  return type;
}

export function readOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const id = value.trim();
  if (!id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

export function isClouddiskHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === ATTACHMENT_HOST || host.endsWith(`.${ATTACHMENT_HOST}`);
}

export function isOssVirtualHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  const suffix = `.${OSS_APEX}`;
  if (!host.endsWith(suffix)) return false;
  const labels = host.slice(0, -suffix.length).split(".");
  if (labels.length !== 2) return false;
  const [bucket, service] = labels;
  if (!bucket || !service || bucket.startsWith("xn--") || service.startsWith("xn--")) return false;
  return BUCKET_LABEL.test(bucket) && OSS_SERVICE_LABEL.test(service);
}

export function attachmentFetchUrl(value: string): URL | null {
  const url = parseHttpsUrl(value, INITIAL_URL_MAX);
  if (!url || !isClouddiskHost(url.hostname)) return null;
  return url;
}

export function attachmentRedirectTarget(value: string): string | null {
  const trimmed = value.trim();
  const url = parseHttpsUrl(trimmed, REDIRECT_URL_MAX);
  if (!url || (!isClouddiskHost(url.hostname) && !isOssVirtualHost(url.hostname))) return null;
  return trimmed;
}

export function readAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^att_[A-Za-z0-9_-]{4,64}$/.test(value)) {
    throw new Error("Attachment id is invalid.");
  }
  return value;
}

export function redactSensitive(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.origin === "https://message.alibaba.com" && parsed.search === "" && parsed.username === "") {
          return `${parsed.origin}${parsed.pathname}`;
        }
      } catch {
        return "[redacted-url]";
      }
      return "[redacted-url]";
    })
    .replace(/\b(?:[a-z0-9-]+\.)*(?:clouddisk\.alibaba\.com|aliyuncs\.com)\b/gi, "[redacted-host]")
    .replace(/\b(?:signature|ossaccesskeyid|security-token|x-oss-[a-z0-9-]+)=[^\s&]+/gi, "[redacted-secret]");
}

export function safeAgentError(message: string): string {
  const known = [
    ATTACHMENT_TOO_LARGE,
    ATTACHMENT_HOST_DENIED,
    ATTACHMENT_FAILED,
    ATTACHMENT_CANCELLED,
    ATTACHMENT_UNAVAILABLE,
    "Attachment download timed out.",
  ];
  if (known.includes(message)) return message;
  const redacted = redactSensitive(message).replace(/\s+/g, " ").trim().slice(0, 500);
  if (known.includes(redacted)) return redacted;
  if (redacted.includes("[redacted-url]") || redacted.includes("[redacted-host]") || redacted.includes("[redacted-secret]")) {
    return ATTACHMENT_FAILED;
  }
  if (/cancel/i.test(redacted)) return ATTACHMENT_CANCELLED;
  if (/size limit|too large|100 MiB/i.test(redacted)) return ATTACHMENT_TOO_LARGE;
  if (/not available in this page/i.test(redacted)) return ATTACHMENT_UNAVAILABLE;
  if (/timed out/i.test(redacted)) return "Attachment download timed out.";
  const besidesInbox = redacted.replace(/https:\/\/message\.alibaba\.com(?:\/[^\s"'<>\\]*)?/gi, "");
  if (/https?:\/\//i.test(besidesInbox) || !redacted) return ATTACHMENT_FAILED;
  return redacted;
}

export function readPreparedAttachment(value: unknown): PreparedAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.downloadUrl === "string" ? record.downloadUrl : typeof record.url === "string" ? record.url : "";
  if (!rawUrl) return null;
  const byteSize = finiteByteSize(record.sizeBytes ?? record.byteSize);
  const contentType = safeContentType(record.type ?? record.contentType);
  return {
    url: rawUrl,
    name: sanitizeFileName(record.name),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(contentType ? { contentType } : {}),
  };
}

export function publicAttachmentList(value: unknown): { attachments: PublicAttachment[] } {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { attachments?: unknown }).attachments)
      ? (value as { attachments: unknown[] }).attachments
      : [];
  const attachments: PublicAttachment[] = [];
  for (const item of source) {
    const parsed = publicAttachment(item);
    if (parsed) attachments.push(parsed);
    if (attachments.length >= 100) break;
  }
  return { attachments };
}

export function encodeChunkFrame(id: string, offset: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff_ffff) throw new Error("Invalid chunk offset.");
  const idBytes = new TextEncoder().encode(id);
  if (idBytes.length < 1 || idBytes.length > 100) throw new Error("Invalid download id.");
  if (payload.byteLength < 1 || payload.byteLength > DOWNLOAD_CHUNK_BYTES) throw new Error("Chunk is too large.");
  const frame = new Uint8Array(8 + idBytes.length + payload.byteLength);
  frame[0] = FRAME_MAGIC;
  frame[1] = FRAME_VERSION;
  frame[2] = FRAME_CHUNK;
  frame[3] = idBytes.length;
  frame.set(idBytes, 4);
  new DataView(frame.buffer).setUint32(4 + idBytes.length, offset, false);
  frame.set(payload, 8 + idBytes.length);
  return frame;
}

export function decodeChunkFrame(input: Uint8Array): ChunkFrame | null {
  if (input.byteLength < 9) return null;
  if (input[0] !== FRAME_MAGIC || input[1] !== FRAME_VERSION || input[2] !== FRAME_CHUNK) return null;
  const idLength = input[3] ?? 0;
  if (idLength < 1 || idLength > 100 || input.byteLength < 8 + idLength) return null;
  const id = new TextDecoder().decode(input.subarray(4, 4 + idLength));
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) return null;
  const offset = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(4 + idLength, false);
  const data = input.subarray(8 + idLength);
  if (data.byteLength < 1 || data.byteLength > DOWNLOAD_CHUNK_BYTES) return null;
  return { id, offset, data: new Uint8Array(data) };
}

export function isDownloadCancel(value: unknown): value is { id: string; type: "download-cancel" } {
  if (!value || typeof value !== "object") return false;
  const record = value as { id?: unknown; type?: unknown };
  return record.type === "download-cancel" && typeof record.id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(record.id);
}

function publicAttachment(value: unknown): PublicAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^att_[A-Za-z0-9_-]{4,64}$/.test(record.id)) return null;
  const id = record.id;
  const messageId = typeof record.messageId === "string" ? safeOptionalId(record.messageId) : undefined;
  const byteSize = finiteByteSize(record.sizeBytes ?? record.byteSize);
  const contentType = safeContentType(record.type ?? record.contentType);
  return {
    id,
    name: sanitizeFileName(record.name),
    ...(messageId ? { messageId } : {}),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(contentType ? { contentType } : {}),
  };
}

function safeOptionalId(value: string): string | undefined {
  try {
    return readOpaqueId(value, "Message id");
  } catch {
    return undefined;
  }
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function parseHttpsUrl(value: string, maxLength: number): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\s<>]/.test(trimmed) || trimmed.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = normalizeHost(url.hostname);
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return url;
}

function finiteByteSize(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
