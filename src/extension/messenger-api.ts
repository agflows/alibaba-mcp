import type { ChatMessage, ConversationDetail, ConversationSummary } from "../shared/protocol.js";

export const MESSENGER_CSRF_URL = "https://onetalk.alibaba.com/csrf/getToken.htm";
export const MESSENGER_HISTORY_URL = "https://onetalk.alibaba.com/message/listRecentMessage.htm";

const PAGE_SIZE = 20;
const MAX_PAGES = 26;
const MAX_MESSAGE_LENGTH = 10_000;
const SEND_ACK_MS = 5_000;
const SEND_POLL_MS = 400;
const SEND_POLLS = 10;
const SEND_BUDGET_MS = 18_000;
const DEDUPE_MS = 15_000;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,220}(?:#[A-Za-z0-9_-]{1,40})?(?:@[A-Za-z0-9._-]{1,40})?$/;

export class MessengerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessengerUnavailable";
  }
}

export interface MessengerResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface MessengerDeps {
  fetchImpl(
    url: string,
    init: { method: "POST"; credentials: "include"; headers?: Record<string, string>; body?: string },
  ): Promise<MessengerResponse>;
  now(): number;
  sleep(ms: number): Promise<void>;
  conversationRecords(): unknown;
  canSend(): boolean;
  sendText(cid: string, content: string): unknown;
}

interface ListedConversation {
  id: string;
  title: string;
  preview: string;
  unread: boolean;
  timestamp?: string;
  sortTime: number;
}

interface HistoryMessage {
  id: string;
  text: string;
  direction: ChatMessage["direction"];
  sender: string;
  timestamp?: string;
  sendTime: number;
}

interface VerifiedSend {
  key: string;
  at: number;
  messageId?: string;
}

export interface MessengerSendResult {
  sent: true;
  verified: true;
  messageId?: string;
  deduped?: true;
}

export interface MessengerStatus {
  conversationCount: number;
  messageServiceReady: boolean;
}

export interface MessengerClient {
  status(): MessengerStatus;
  listConversations(limit: number, search: string): ConversationSummary[];
  getConversation(conversationId: string, limit: number): Promise<ConversationDetail>;
  sendMessage(conversationId: string, text: string): Promise<MessengerSendResult>;
}

export function createMessenger(deps: MessengerDeps): MessengerClient {
  let gate: Promise<void> = Promise.resolve();
  let lastVerified: VerifiedSend | undefined;

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = gate.then(task, task);
    gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    status() {
      return {
        conversationCount: readRecords(deps.conversationRecords()).length,
        messageServiceReady: deps.canSend(),
      };
    },
    listConversations(limit: number, search: string) {
      const records = readRecords(deps.conversationRecords());
      if (!records.length) {
        throw new MessengerUnavailable("Alibaba's conversation list is not loaded in this tab yet.");
      }
      const query = search.trim().toLocaleLowerCase();
      const listed = records
        .filter((record) => record.visible !== false)
        .map(toSummary)
        .filter((conversation): conversation is ListedConversation => conversation !== null)
        .sort((left, right) => right.sortTime - left.sortTime || left.title.localeCompare(right.title));
      const matched = query
        ? listed.filter((conversation) => `${conversation.title}\n${conversation.preview}`.toLocaleLowerCase().includes(query))
        : listed;
      return matched.slice(0, clamp(limit, 1, 100)).map(publicSummary);
    },
    getConversation(conversationId: string, limit: number) {
      return exclusive(() => readConversation(deps, conversationId, clamp(limit, 1, 500)));
    },
    sendMessage(conversationId: string, text: string) {
      return exclusive(() => deliver(deps, conversationId, text, () => lastVerified, (next) => {
        lastVerified = next;
      }));
    },
  };
}

async function readConversation(deps: MessengerDeps, conversationId: string, limit: number): Promise<ConversationDetail> {
  const id = canonicalConversationId(conversationId);
  const contact = contactName(deps, id);
  const messages = await loadHistory(deps, id, limit, contact);
  return { id, title: contact.title, messages };
}

async function deliver(
  deps: MessengerDeps,
  conversationId: string,
  text: string,
  readLast: () => VerifiedSend | undefined,
  writeLast: (next: VerifiedSend) => void,
): Promise<MessengerSendResult> {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error("Message text cannot be empty.");
  if (normalized.length > MAX_MESSAGE_LENGTH) throw new Error("Message text is too long.");
  const id = canonicalConversationId(conversationId);
  const key = `${id}\u0000${normalized}`;
  const recent = readLast();
  if (recent && recent.key === key && deps.now() - recent.at < DEDUPE_MS) {
    return { sent: true, verified: true, ...(recent.messageId ? { messageId: recent.messageId } : {}), deduped: true };
  }
  if (!deps.canSend()) {
    throw new MessengerUnavailable("Alibaba's message service is not loaded in this tab. Reload the messenger page and try again.");
  }

  const contact = contactName(deps, id);
  const started = deps.now();
  const before = await loadHistory(deps, id, PAGE_SIZE, contact);
  const seen = new Set(before.map((message) => message.id));
  let dispatched = false;
  let rejected = false;
  try {
    const result = deps.sendText(id, text);
    dispatched = true;
    const pending = Promise.resolve(result).then(
      () => undefined,
      () => {
        rejected = true;
      },
    );
    await Promise.race([pending, deps.sleep(SEND_ACK_MS)]);
  } catch {
    dispatched = false;
  }

  const attempts = dispatched && !rejected ? SEND_POLLS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deps.now() - started > SEND_BUDGET_MS) break;
    if (dispatched && attempt > 0) await deps.sleep(SEND_POLL_MS);
    try {
      const after = await loadHistory(deps, id, PAGE_SIZE, contact);
      const confirmed = after.find((message) => message.direction === "outgoing" && !seen.has(message.id) && sameText(normalized, message.text));
      if (confirmed) {
        writeLast({ key, at: deps.now(), ...(confirmed.id ? { messageId: confirmed.id } : {}) });
        return { sent: true, verified: true, ...(confirmed.id ? { messageId: confirmed.id } : {}) };
      }
    } catch (error) {
      if (!dispatched) throw error;
    }
  }

  if (!dispatched || rejected) {
    throw new Error("Alibaba's message service rejected the request before sending. It is safe to retry.");
  }
  throw new Error("Alibaba did not confirm the sent message. Do not retry yet; check the conversation to avoid a duplicate.");
}

async function loadHistory(deps: MessengerDeps, conversationId: string, limit: number, contact: { name: string }): Promise<HistoryMessage[]> {
  const token = await csrfToken(deps);
  const collected: HistoryMessage[] = [];
  const seen = new Set<string>();
  let cursor: number | null = null;
  let previousCursor: number | null = null;

  for (let page = 0; page < MAX_PAGES && collected.length < limit; page += 1) {
    const payload = await postHistory(deps, token, {
      pointTimeStamp: cursor,
      forward: false,
      count: PAGE_SIZE,
      conversationId,
    });
    const batch = historyMessages(payload, contact.name).filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
    if (!batch.length) break;
    collected.push(...batch);
    const nextCursor = nextPoint(payload, batch);
    if (!payloadHasMore(payload) || nextCursor === null || nextCursor === previousCursor || nextCursor === cursor) break;
    previousCursor = cursor;
    cursor = nextCursor;
  }

  collected.sort((left, right) => left.sendTime - right.sendTime || left.id.localeCompare(right.id));
  return collected.slice(-limit);
}

async function csrfToken(deps: MessengerDeps): Promise<string> {
  const response = await deps.fetchImpl(MESSENGER_CSRF_URL, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error(`Alibaba did not issue a messenger token (HTTP ${response.status}).`);
  const body = await readJson(response);
  const token = field(body, "token");
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{8,200}$/.test(token)) {
    throw new Error("Alibaba did not issue a messenger token.");
  }
  return token;
}

async function postHistory(
  deps: MessengerDeps,
  token: string,
  params: { pointTimeStamp: number | null; forward: false; count: number; conversationId: string },
): Promise<Record<string, unknown>> {
  const body = `params=${encodeURIComponent(JSON.stringify(params))}&_csrf=${encodeURIComponent(token)}`;
  const response = await deps.fetchImpl(MESSENGER_HISTORY_URL, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Alibaba messenger history returned HTTP ${response.status}.`);
  const payload = await readJson(response);
  const code = field(payload, "code");
  const codeText = typeof code === "number" || typeof code === "string" ? String(code) : "";
  if (codeText !== "200") throw new Error(`Alibaba messenger history was rejected${codeText ? ` (${codeText})` : ""}.`);
  const data = field(payload, "data");
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function historyMessages(data: Record<string, unknown>, contactName: string): HistoryMessage[] {
  const list = field(data, "messageList");
  if (!Array.isArray(list)) return [];
  const messages: HistoryMessage[] = [];
  for (const item of list) {
    const message = toHistoryMessage(item, contactName);
    if (message) messages.push(message);
  }
  return messages;
}

function toHistoryMessage(value: unknown, contactName: string): HistoryMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const messageType = numeric(record.messageType);
  const text = presentContent(messageType, record.content);
  if (!text) return null;
  const direction = directionOf(record.messageSendType);
  const sendTime = numeric(record.sendTime) ?? 0;
  const id = safeId(record.messageId) || `t-${sendTime}-${direction}-${fnv32(text).toString(16)}`;
  return {
    id,
    text,
    direction,
    sender: direction === "outgoing" ? "You" : direction === "incoming" ? contactName : "Alibaba",
    ...(sendTime > 0 ? { timestamp: new Date(sendTime).toISOString() } : {}),
    sendTime,
  };
}

function presentContent(messageType: number | undefined, content: unknown): string {
  const raw = typeof content === "string" ? content : "";
  if (messageType === 53) return attachmentLabel("file", raw);
  if (messageType === 60) return attachmentLabel("image", raw);
  if (messageType === 9999) return plain(raw) || "[System message]";
  return plain(raw);
}

function attachmentLabel(kind: "file" | "image", raw: string): string {
  const parsed = parseObject(raw);
  const name = safeName(parsed.fileName ?? parsed.file_name ?? parsed.name);
  const size = safeSize(parsed.fileSize ?? parsed.size);
  if (kind === "image") return name ? `[Image: ${name}]` : "[Image]";
  if (name && size !== undefined) return `[Attachment: ${name}, ${size} bytes]`;
  if (name) return `[Attachment: ${name}]`;
  return "[Attachment]";
}

function payloadHasMore(data: Record<string, unknown>): boolean {
  return field(data, "hasMore") === true;
}

function nextPoint(data: Record<string, unknown>, batch: readonly HistoryMessage[]): number | null {
  const declared = numeric(field(data, "nextPointTimeStamp"));
  if (declared && declared > 0) return declared;
  let oldest = Number.POSITIVE_INFINITY;
  for (const message of batch) {
    if (message.sendTime > 0 && message.sendTime < oldest) oldest = message.sendTime;
  }
  return Number.isFinite(oldest) ? oldest : null;
}

function contactName(deps: MessengerDeps, conversationId: string): { name: string; title: string } {
  const match = readRecords(deps.conversationRecords()).find((record) => canonicalOrEmpty(record.cid) === conversationId);
  const name = safeName(match?.name) || "Unknown contact";
  const company = safeName(match?.companyName);
  return { name, title: company ? `${name} — ${company}` : name };
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function toSummary(record: Record<string, unknown>): ListedConversation | null {
  const id = canonicalOrEmpty(record.cid);
  if (!id) return null;
  const name = safeName(record.name) || "Unknown contact";
  const company = safeName(record.companyName);
  const preview = previewText(record);
  const sortTime = numeric(record.lastContactTime) ?? numeric(record.lastContactTimeLong) ?? 0;
  return {
    id,
    title: company ? `${name} — ${company}` : name,
    preview,
    unread: (numeric(record.unreadCount) ?? 0) > 0,
    ...(sortTime > 0 ? { timestamp: new Date(sortTime).toISOString() } : {}),
    sortTime,
  };
}

function previewText(record: Record<string, unknown>): string {
  const last = record.lastMsg;
  if (typeof last === "string") return plain(last).slice(0, 240);
  if (!last || typeof last !== "object" || Array.isArray(last)) return "";
  const content = (last as { content?: unknown }).content;
  return typeof content === "string" ? plain(content).slice(0, 240) : "";
}

function publicSummary(conversation: ListedConversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    preview: conversation.preview,
    unread: conversation.unread,
    ...(conversation.timestamp ? { timestamp: conversation.timestamp } : {}),
  };
}

function directionOf(value: unknown): ChatMessage["direction"] {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "send" || text === "out" || text === "outgoing") return "outgoing";
  if (text === "rec" || text === "receive" || text === "incoming") return "incoming";
  return "unknown";
}

function sameText(expected: string, actual: string): boolean {
  return normalizeText(plain(expected)) === normalizeText(plain(actual));
}

function plain(value: string): string {
  const decoded = decodeEntities(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = decoded.replace(/<[^>]+>/g, " ");
  return redactTransportSecrets(normalizeText(withoutTags)).slice(0, MAX_MESSAGE_LENGTH);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function redactTransportSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => (isSensitiveUrl(raw) ? "[attachment]" : raw))
    .replace(/\b(?:cookie|authorization|x-auth-token)\b\s*[:=]\s*\S+/gi, "[redacted]");
}

function isSensitiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return true;
    const host = url.hostname.toLowerCase();
    if (host === "clouddisk.alibaba.com" || host.endsWith(".clouddisk.alibaba.com") || host.endsWith(".aliyuncs.com")) return true;
    return /[?&#](?:token|sign|signature|auth|cookie|access_token|x-auth-token|ossaccesskeyid|security-token)=/i.test(`${url.search}${url.hash}`);
  } catch {
    return true;
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface MessengerSendPayload {
  cid: string;
  content: string;
  msgType: 1;
  chatToken?: string;
  aliId?: string | number;
  ext: { chatScene: string };
}

export function messengerSendPayload(conversationId: string, content: string, records: unknown): MessengerSendPayload {
  const id = canonicalConversationId(conversationId);
  const match = readRecords(records).find((record) => canonicalOrEmpty(record.cid) === id);
  const chatToken = typeof match?.chatToken === "string" ? match.chatToken.trim() : "";
  const aliId = match?.aliId;
  const contactId = typeof aliId === "number" && Number.isFinite(aliId) ? aliId : typeof aliId === "string" && aliId.trim() ? aliId.trim() : undefined;
  return {
    cid: id,
    content,
    msgType: 1,
    ...(chatToken && chatToken.length <= 4_000 && !/[\u0000-\u001f\u007f]/.test(chatToken) ? { chatToken } : {}),
    ...(contactId !== undefined ? { aliId: contactId } : {}),
    ext: { chatScene: JSON.stringify({ clientInfo: "web" }) },
  };
}

export function canonicalConversationId(value: string): string {
  const id = value.trim();
  if (!CONVERSATION_ID.test(id)) throw new Error("Conversation id is not in Alibaba's format.");
  if (id.includes("@")) return id;
  return id.includes("#") ? `${id}@icbu` : id;
}

function canonicalOrEmpty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return canonicalConversationId(value);
  } catch {
    return "";
  }
}

function safeName(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
  if (!text || /https?:|token|cookie|signature|[/\\<>]/.test(text)) return "";
  return text;
}

function safeId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value)).slice(0, 200);
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(text) ? text : "";
}

function safeSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 2_000_000_000) return Math.floor(value);
  if (typeof value === "string" && /^\d{1,12}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d{1,16}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return (value as Record<string, unknown>)[key];
}

async function readJson(response: MessengerResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Alibaba returned an unreadable messenger response.");
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? Math.trunc(value) : min, max));
}

function fnv32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
