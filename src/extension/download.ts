import {
  ATTACHMENT_CANCELLED,
  ATTACHMENT_FAILED,
  ATTACHMENT_HOST_DENIED,
  ATTACHMENT_TOO_LARGE,
  DOWNLOAD_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
  attachmentFetchUrl,
  attachmentRedirectTarget,
  encodeChunkFrame,
  readPreparedAttachment,
  safeAgentError,
  safeContentType,
} from "../shared/attachments.js";

export interface AttachmentFetchInit {
  credentials?: RequestCredentials;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrerPolicy?: ReferrerPolicy;
  signal?: AbortSignal;
}

export interface StreamAttachmentOptions {
  id: string;
  prepare: () => Promise<unknown>;
  fetchImpl?: (input: string, init: AttachmentFetchInit) => Promise<Response>;
  sendJson: (message: Record<string, unknown>) => void;
  sendBinary: (frame: Uint8Array) => void;
  signal: AbortSignal;
  maxBytes?: number;
}

export async function streamAttachment(options: StreamAttachmentOptions): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let settled = false;
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    options.sendJson({ id: options.id, type: "download-error", error: safeAgentError(message) });
  };

  try {
    if (options.signal.aborted) throw new AttachmentFlowError(ATTACHMENT_CANCELLED);
    const prepared = readPreparedAttachment(await options.prepare());
    if (!prepared) throw new AttachmentFlowError(ATTACHMENT_FAILED);
    if (prepared.byteSize !== undefined && prepared.byteSize > maxBytes) throw new AttachmentFlowError(ATTACHMENT_TOO_LARGE);
    const requested = prepared.url.trim();
    if (!attachmentFetchUrl(requested)) throw new AttachmentFlowError(ATTACHMENT_HOST_DENIED);
    const response = await fetchAllowlisted(requested, fetchImpl, options.signal);
    const declared = contentLength(response);
    if (declared !== undefined && declared > maxBytes) throw new AttachmentFlowError(ATTACHMENT_TOO_LARGE);
    const contentType = prepared.contentType ?? safeContentType(response.headers.get("content-type"));
    options.sendJson({
      id: options.id,
      type: "download-start",
      name: prepared.name,
      ...(contentType ? { contentType } : {}),
      ...(prepared.byteSize === undefined ? {} : { byteSize: prepared.byteSize }),
    });
    const byteSize = await pumpBody(response, options, maxBytes);
    if (prepared.byteSize !== undefined && prepared.byteSize !== byteSize) throw new AttachmentFlowError(ATTACHMENT_FAILED);
    if (options.signal.aborted) throw new AttachmentFlowError(ATTACHMENT_CANCELLED);
    settled = true;
    options.sendJson({ id: options.id, type: "download-end", byteSize });
  } catch (error) {
    if (options.signal.aborted) fail(ATTACHMENT_CANCELLED);
    else fail(error instanceof Error ? error.message : ATTACHMENT_FAILED);
  }
}

class AttachmentFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentFlowError";
  }
}

async function fetchAllowlisted(
  target: string,
  fetchImpl: NonNullable<StreamAttachmentOptions["fetchImpl"]>,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(target, {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch {
    if (signal.aborted) throw new AttachmentFlowError(ATTACHMENT_CANCELLED);
    throw new AttachmentFlowError(ATTACHMENT_FAILED);
  }
  if (response.type === "opaqueredirect" || response.status === 0 || !attachmentRedirectTarget(response.url)) {
    await discard(response);
    throw new AttachmentFlowError(ATTACHMENT_HOST_DENIED);
  }
  if (!response.ok) {
    await discard(response);
    throw new AttachmentFlowError(ATTACHMENT_FAILED);
  }
  return response;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function pumpBody(response: Response, options: StreamAttachmentOptions, maxBytes: number): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) throw new AttachmentFlowError(ATTACHMENT_FAILED);
  let offset = 0;
  try {
    while (true) {
      if (options.signal.aborted) throw new AttachmentFlowError(ATTACHMENT_CANCELLED);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      let view = value;
      while (view.byteLength > 0) {
        const piece = view.subarray(0, DOWNLOAD_CHUNK_BYTES);
        if (offset + piece.byteLength > maxBytes) throw new AttachmentFlowError(ATTACHMENT_TOO_LARGE);
        options.sendBinary(encodeChunkFrame(options.id, offset, piece));
        offset += piece.byteLength;
        view = view.subarray(piece.byteLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return offset;
}
