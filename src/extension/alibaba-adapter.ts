import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
} from "../shared/protocol.js";

const CONVERSATION_PROFILES = [
  { name: "contact-item", selector: '[data-observer-trigger="contact-item"][data-cid]' },
  { name: "cid-role-name", selector: '[role="button"][data-cid][data-name]' },
  { name: "contact-container", selector: ".contact-item-container[data-cid]" },
  { name: "cid-and-name", selector: "[data-cid][data-name]:not([data-expinfo])" },
] as const;

const MESSAGE_PROFILES = [
  { name: "tracked-message", selector: '[data-expinfo][data-original][data-clk="2020MC_Message_Click"]' },
  { name: "wrapper-message", selector: ".message-item-wrapper[data-expinfo][data-original]" },
  { name: "expinfo-original", selector: "[data-expinfo][data-original]" },
  { name: "message-id", selector: "[data-message-id][data-original], [data-mid][data-original]" },
  { name: "direction-original", selector: "[data-direction][data-original]" },
] as const;

const ATTACHMENT_PROFILES = [
  { name: "data-query", selector: "[data-query]" },
  { name: "attachment-id", selector: "[data-attachment-id]" },
  { name: "file-id", selector: "[data-file-id], [data-fileid]" },
  { name: "file-name", selector: "[data-file-name], [data-filename]" },
  { name: "download-url", selector: "[data-download-url], [data-file-url]" },
  { name: "clouddisk-link", selector: 'a[href*="clouddisk.alibaba.com"]' },
] as const;

const COMPOSER_PROFILES = [
  { name: "placeholder-message", selector: 'textarea[placeholder="Please enter your message here"]' },
  { name: "send-textarea", selector: "textarea.send-textarea" },
  { name: "composer-data", selector: 'textarea[data-role="composer"], textarea[data-composer], textarea[name="message"]' },
  { name: "labelled-composer", selector: 'textarea[aria-label="Message"], textarea[aria-label="Please enter your message here"]' },
  { name: "message-box-textarea", selector: ".message-box textarea" },
] as const;

const COMPANY_SELECTORS = [".contact-company", "[data-company]", '[class*="company"]'];
const NAME_SELECTORS = [".contact-name", ".name"];
const TIME_SELECTORS = [".contact-time", "time", "[data-time]"];
const OUTGOING_FLOW = new Set(["out", "outgoing", "send", "self", "right"]);
const INCOMING_FLOW = new Set(["in", "incoming", "receive", "left"]);
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_ORIGINAL_LENGTH = 100_000;
const MAX_ATTACHMENTS = 50;
const CLOUDDISK_HOST = "clouddisk.alibaba.com";

const DEFAULT_TIMEOUTS = {
  select: 8_000,
  quiet: 300,
  composer: 8_000,
  sendEnable: 2_000,
  sendVerify: 10_000,
  poll: 25,
  dedupe: 4_000,
};

interface SelectorProfile {
  readonly name: string;
  readonly selector: string;
}

interface ProfileMatch<T extends Element> {
  elements: T[];
  selector?: string;
  name?: string;
}

interface MessageSnapshot {
  ids: Set<string>;
  elements: Set<HTMLElement>;
  signature: string;
}

interface SendAttempt {
  key: string;
  conversationId: string;
  at: number;
  outcome: "verified" | "ambiguous" | "failed";
  messageId?: string;
  snapshot: MessageSnapshot;
}

interface SendControl {
  element: HTMLElement;
  name: string;
  selector: string;
}

export interface AdapterOptions {
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
}

export interface AdapterHealth {
  supportedHost: boolean;
  href: string;
  readyState: DocumentReadyState;
  inboxLoaded: boolean;
  conversationCount: number;
  messageCount: number;
  attachmentCount: number;
  composerAvailable: boolean;
  sendButtonAvailable: boolean;
  sendButtonEnabled: boolean;
  selectedConversationId?: string;
  operationPending: boolean;
  selectorProfile: {
    conversations?: string;
    messages?: string;
    composer?: string;
    sendButton?: string;
  };
  profileNames: {
    conversations?: string;
    messages?: string;
    composer?: string;
    sendButton?: string;
    attachments?: string;
  };
  warnings: string[];
  lastSend?: {
    outcome: SendAttempt["outcome"];
    conversationId: string;
    ageMs: number;
    messageId?: string;
  };
}

export interface SendResult {
  sent: true;
  verified: true;
  messageId?: string;
  deduped?: true;
}

export interface AttachmentSummary {
  id: string;
  messageId: string;
  name: string;
  sizeBytes?: number;
  type?: string;
}

export interface PreparedAttachment extends AttachmentSummary {
  downloadUrl: string;
}

interface AttachmentDraft {
  name: string;
  sizeBytes?: number;
  type?: string;
  downloadUrl?: string;
  profile: string;
  fileKey: string;
}

interface CollectedAttachment {
  listed: AttachmentSummary;
  downloadUrl?: string;
  profile: string;
}

export class AlibabaAdapter {
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  private gate: Promise<void> = Promise.resolve();
  private depth = 0;
  private lastAttempt?: SendAttempt;

  constructor(options: AdapterOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  health(): AdapterHealth {
    const conversations = queryProfile<HTMLElement>(CONVERSATION_PROFILES);
    const messages = queryProfile<HTMLElement>(MESSAGE_PROFILES);
    const composer = queryProfile<HTMLTextAreaElement>(COMPOSER_PROFILES);
    const textarea = composer.elements[0];
    const send = textarea ? locateSendControl(textarea) : undefined;
    const selected = conversations.elements.filter(isSelected);
    const warnings: string[] = [];

    if (location.hostname !== "message.alibaba.com") {
      warnings.push(`Active host is ${location.hostname || "unknown"}; expected message.alibaba.com.`);
    }
    if (document.readyState === "loading") warnings.push("Document is still loading.");
    if (!conversations.elements.length) {
      warnings.push("No conversations matched. Confirm you are logged in and the inbox has finished loading.");
    }
    warnFallback(warnings, "Conversation list", conversations, CONVERSATION_PROFILES);
    warnFallback(warnings, "Message list", messages, MESSAGE_PROFILES);
    warnFallback(warnings, "Composer", composer, COMPOSER_PROFILES);
    if (!textarea) warnings.push("Message composer is not available.");
    else if (!send) warnings.push("Send control is not available in the message composer.");
    else if (!isEnabledControl(send.element)) warnings.push("Send control is present but disabled.");
    if (selected.length > 1) warnings.push("Multiple conversations appear selected.");

    const selectedElement = selected[0];
    const selectedId = selectedElement ? conversationId(selectedElement) : undefined;
    const attachments = collectAttachments(messages.elements, selectedId);
    const attachmentProfile = attachments[0]?.profile;
    return {
      supportedHost: location.hostname === "message.alibaba.com",
      href: safeLocationHref(),
      readyState: document.readyState,
      inboxLoaded: conversations.elements.length > 0,
      conversationCount: conversations.elements.length,
      messageCount: messages.elements.length,
      attachmentCount: attachments.length,
      composerAvailable: Boolean(textarea),
      sendButtonAvailable: Boolean(send),
      sendButtonEnabled: Boolean(send && isEnabledControl(send.element)),
      ...(selectedElement ? { selectedConversationId: conversationId(selectedElement) || undefined } : {}),
      operationPending: this.depth > 0,
      selectorProfile: {
        conversations: conversations.selector,
        messages: messages.selector,
        composer: composer.selector,
        sendButton: send?.selector,
      },
      profileNames: {
        conversations: conversations.name,
        messages: messages.name,
        composer: composer.name,
        sendButton: send?.name,
        attachments: attachmentProfile,
      },
      warnings,
      ...(this.lastAttempt
        ? {
            lastSend: {
              outcome: this.lastAttempt.outcome,
              conversationId: this.lastAttempt.conversationId,
              ageMs: Math.max(0, Date.now() - this.lastAttempt.at),
              ...(this.lastAttempt.messageId ? { messageId: this.lastAttempt.messageId } : {}),
            },
          }
        : {}),
    };
  }

  listConversations(limit: number, search: string): ConversationSummary[] {
    this.ensureInbox();
    const query = search.trim().toLocaleLowerCase();
    const seen = new Set<string>();
    const conversations: ConversationSummary[] = [];
    for (const element of this.conversationElements()) {
      const conversation = parseConversation(element);
      if (!conversation.id || seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      if (query && !`${conversation.title}\n${conversation.preview}`.toLocaleLowerCase().includes(query)) continue;
      conversations.push(conversation);
      if (conversations.length >= clamp(limit, 1, 100)) break;
    }
    return conversations;
  }

  async getConversation(conversationId: string, limit: number): Promise<ConversationDetail> {
    return this.exclusive(async () => {
      const element = await this.selectConversation(conversationId);
      const summary = parseConversation(element);
      const contactName = element.dataset.name?.trim() || summary.title || "Unknown contact";
      const selfId = detectSelfId();
      const messages = this.messageElements()
        .map((message, index) => parseMessage(message, index, contactName, selfId))
        .filter((message): message is ChatMessage => Boolean(message))
        .slice(-clamp(limit, 1, 500));
      return { id: conversationId, title: summary.title, messages };
    });
  }

  async listAttachments(conversationId: string): Promise<AttachmentSummary[]> {
    return this.exclusive(async () => {
      await this.selectConversation(conversationId);
      return collectAttachments(this.messageElements(), conversationId).map((item) => item.listed);
    });
  }

  async prepareAttachment(conversationId: string, attachmentId: string): Promise<PreparedAttachment> {
    if (!isOpaqueAttachmentId(attachmentId)) throw new Error("Attachment id is required.");
    return this.exclusive(async () => {
      await this.selectConversation(conversationId);
      const match = collectAttachments(this.messageElements(), conversationId).find((item) => item.listed.id === attachmentId);
      if (!match) throw new Error("Attachment is not in the selected conversation.");
      if (!match.downloadUrl) throw new Error("Attachment has no Alibaba clouddisk download URL.");
      return { ...match.listed, downloadUrl: match.downloadUrl };
    });
  }

  async sendMessage(conversationId: string, text: string): Promise<SendResult> {
    const normalized = normalizeText(text);
    if (!normalized) throw new Error("Message text cannot be empty.");
    if (normalized.length > MAX_MESSAGE_LENGTH) throw new Error("Message text is too long.");
    return this.exclusive(() => this.deliverMessage(conversationId, text, normalized));
  }

  private async deliverMessage(conversationId: string, text: string, normalized: string): Promise<SendResult> {
    const key = `${conversationId}\u0000${normalized}`;
    const recent = this.lastAttempt;
    if (recent && recent.key === key && Date.now() - recent.at < this.timeouts.dedupe) {
      if (recent.outcome === "verified") {
        return { sent: true, verified: true, ...(recent.messageId ? { messageId: recent.messageId } : {}), deduped: true };
      }
      if (recent.outcome === "ambiguous") {
        await this.selectConversation(conversationId);
        const recovered = this.findUnseenOutgoing(normalized, recent.snapshot);
        if (recovered) return this.rememberVerified(key, conversationId, recovered, true);
        throw new Error(
          "The previous send was not confirmed. Check the conversation before sending the same text again.",
        );
      }
    }

    await this.selectConversation(conversationId);
    const snapshot = this.snapshotMessages();
    const textarea = await waitForAny<HTMLTextAreaElement>(
      COMPOSER_PROFILES,
      this.timeouts.composer,
      "message composer",
      this.timeouts.poll,
    );
    const send = locateSendControl(textarea);
    if (!send) throw new Error("Could not locate Alibaba's Send control in the message composer.");

    setTextareaValue(textarea, text);
    try {
      await waitUntil(
        () => isEnabledControl(send.element),
        this.timeouts.sendEnable,
        "Alibaba did not enable the Send control for this conversation.",
        this.timeouts.poll,
      );
    } catch (error) {
      setTextareaValue(textarea, "");
      throw error;
    }

    if (!this.findUnseenOutgoing(normalized, snapshot)) send.element.click();

    try {
      const sent = await waitForValue(
        () => this.findUnseenOutgoing(normalized, snapshot),
        this.timeouts.sendVerify,
        "Alibaba did not confirm the sent message.",
        this.timeouts.poll,
      );
      this.clearDraftIfUnchanged(textarea, normalized);
      return this.rememberVerified(key, conversationId, sent, false);
    } catch {
      const late = this.findUnseenOutgoing(normalized, snapshot);
      if (late) {
        this.clearDraftIfUnchanged(textarea, normalized);
        return this.rememberVerified(key, conversationId, late, false);
      }
      const stillDrafted = normalizeText(textarea.value) === normalized;
      this.lastAttempt = { key, conversationId, at: Date.now(), outcome: stillDrafted ? "failed" : "ambiguous", snapshot };
      if (stillDrafted) {
        throw new Error(
          "Alibaba did not show a newly sent message. The draft is still in the composer, so it is safe to retry.",
        );
      }
      throw new Error(
        "Alibaba did not confirm the sent message. Do not retry yet; check the conversation to avoid a duplicate.",
      );
    }
  }

  private rememberVerified(key: string, conversationId: string, element: HTMLElement, deduped: boolean): SendResult {
    const id = messageId(element) || undefined;
    this.lastAttempt = {
      key,
      conversationId,
      at: Date.now(),
      outcome: "verified",
      ...(id ? { messageId: id } : {}),
      snapshot: this.snapshotMessages(),
    };
    return { sent: true, verified: true, ...(id ? { messageId: id } : {}), ...(deduped ? { deduped: true as const } : {}) };
  }

  private clearDraftIfUnchanged(textarea: HTMLTextAreaElement, normalized: string): void {
    if (normalizeText(textarea.value) === normalized) setTextareaValue(textarea, "");
  }

  private ensureInbox(): void {
    const health = this.health();
    if (!health.supportedHost) throw new Error("The active page is not Alibaba Messages.");
    if (!health.inboxLoaded) {
      throw new Error(
        "Alibaba conversations are not available yet. Confirm you are logged in and the inbox has loaded.",
      );
    }
  }

  private conversationElements(): HTMLElement[] {
    return queryProfile<HTMLElement>(CONVERSATION_PROFILES).elements;
  }

  private messageElements(): HTMLElement[] {
    const seen = new Set<string>();
    const elements: HTMLElement[] = [];
    for (const element of queryProfile<HTMLElement>(MESSAGE_PROFILES).elements) {
      const id = messageId(element);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      elements.push(element);
    }
    return elements;
  }

  private snapshotMessages(): MessageSnapshot {
    const elements = this.messageElements();
    return {
      ids: new Set(elements.map((element) => messageId(element)).filter((id) => id.length > 0)),
      elements: new Set(elements),
      signature: elements.map((element) => messageSignature(element)).join("\u0001"),
    };
  }

  private findUnseenOutgoing(normalized: string, snapshot: MessageSnapshot): HTMLElement | undefined {
    const selfId = detectSelfId();
    return this.messageElements().find((element) => isUnseenOutgoing(element, normalized, snapshot, selfId));
  }

  private findConversation(conversationId: string): HTMLElement | undefined {
    const matches = this.conversationElements().filter((element) => conversationMatches(element, conversationId));
    return matches.find(isSelected) ?? matches[0];
  }

  private async selectConversation(conversationId: string): Promise<HTMLElement> {
    this.ensureInbox();
    const target = this.findConversation(conversationId);
    if (!target) {
      throw new Error(
        "Conversation is not currently loaded in the inbox. Scroll or search for it in Alibaba and retry.",
      );
    }

    const before = this.snapshotMessages();
    const alreadySelected = isSelected(target);
    if (!alreadySelected) target.click();
    await this.waitForConversationReady(conversationId, before, alreadySelected);
    return this.findConversation(conversationId) ?? target;
  }

  private async waitForConversationReady(
    conversationId: string,
    before: MessageSnapshot,
    alreadySelected: boolean,
  ): Promise<void> {
    let sinceChange = Date.now();
    let previous = "";
    let initialized = false;
    try {
      await waitUntil(
        () => {
          const current = this.findConversation(conversationId);
          if (!current || !isSelected(current)) {
            initialized = false;
            return false;
          }
          const signature = this.messageElements().map((element) => messageSignature(element)).join("\u0001");
          const now = Date.now();
          if (!initialized || signature !== previous) {
            initialized = true;
            previous = signature;
            sinceChange = now;
          }
          if (messagePaneBusy()) return false;
          if (now - sinceChange < this.timeouts.quiet) return false;
          if (alreadySelected || signature !== before.signature || before.elements.size === 0) return true;
          return false;
        },
        this.timeouts.select,
        "Timed out loading the Alibaba conversation.",
        this.timeouts.poll,
      );
    } catch (error) {
      const current = this.findConversation(conversationId);
      const signature = this.messageElements().map((element) => messageSignature(element)).join("\u0001");
      if (current && isSelected(current) && !alreadySelected && before.elements.size > 0 && signature === before.signature) {
        throw new Error(
          "Timed out switching conversations. The previously open thread is still shown, so its messages were not returned.",
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.depth += 1;
    return previous.then(task).finally(() => {
      this.depth -= 1;
      release();
    });
  }
}

function warnFallback(
  warnings: string[],
  label: string,
  match: ProfileMatch<Element>,
  profiles: readonly SelectorProfile[],
): void {
  const primary = profiles[0]?.name;
  if (!match.name || !primary || match.name === primary) return;
  warnings.push(`${label} matched fallback profile "${match.name}".`);
}

function parseConversation(element: HTMLElement): ConversationSummary {
  const name = element.dataset.name?.trim() || textOf(element, NAME_SELECTORS) || "Unknown contact";
  const company = textOf(element, COMPANY_SELECTORS);
  const visibleTime = textOf(element, TIME_SELECTORS);
  const title = company ? `${name} — ${company}` : name;
  const lines = readText(element)
    .split("\n")
    .map(normalizeText)
    .filter(Boolean);
  const known = new Set([normalizeText(name), normalizeText(company), normalizeText(visibleTime)]);
  const preview = [...lines].reverse().find((line) => !known.has(line)) || "";
  return {
    id: conversationId(element),
    title,
    preview,
    unread: Number(element.dataset.unreadCount || 0) > 0,
    timestamp: normalizeListTimestamp(visibleTime, element.dataset.modifyTime),
  };
}

function parseMessage(element: HTMLElement, index: number, contactName: string, selfId: string): ChatMessage | null {
  const metadata = parseJson(element.dataset.expinfo);
  const id = messageId(element) || `visible-${index}`;
  const text = extractMessageText(element.dataset.original || "", element);
  if (!text) return null;
  const direction = isOutgoing(element, selfId) ? "outgoing" : "incoming";
  return {
    id,
    sender: direction === "outgoing" ? "You" : contactName,
    text,
    timestamp: normalizeMessageTimestamp(readField(metadata, "sendTime")),
    direction,
  };
}

function extractMessageText(original: string, element: HTMLElement): string {
  const source = original.trim().slice(0, MAX_ORIGINAL_LENGTH);
  const html = source.startsWith("&lt;") ? decodeEntities(source) : source;
  if (html.trim().startsWith("<")) return presentMessageText(extractFromHtml(html));
  if (source && !/^https?:\/\//i.test(source)) return presentMessageText(source);
  return presentMessageText(normalizeVisibleMessage(readText(element)));
}

function presentMessageText(value: string): string {
  return redactTransportSecrets(normalizeText(value)).slice(0, MAX_MESSAGE_LENGTH);
}

function extractFromHtml(markup: string): string {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = inertHtml(markup);
  stripActiveContent(doc);
  const file = doc.querySelector<HTMLElement>("[data-query]");
  if (file?.dataset.query) {
    const details = parseJson(file.dataset.query);
    if (readField(details, "fileName") != null || readField(details, "fileSize") != null) {
      return attachmentLabel(details);
    }
  }
  return normalizeText(doc.body.innerText || doc.body.textContent || "");
}

function attachmentLabel(details: Record<string, unknown>): string {
  const name = safeFileName(readField(details, "fileName")) || "attachment";
  const sizeText = safeSizeText(readField(details, "fileSize"));
  return sizeText ? `[Attachment: ${name}, ${sizeText} bytes]` : `[Attachment: ${name}]`;
}

function collectAttachments(elements: readonly HTMLElement[], conversationId?: string): CollectedAttachment[] {
  const collected: CollectedAttachment[] = [];
  for (const element of elements) {
    if (!messageBelongsTo(element, conversationId)) continue;
    const id = messageId(element);
    if (!id) continue;
    const drafts = draftsFromMessage(element);
    for (let ordinal = 0; ordinal < drafts.length; ordinal += 1) {
      const draft = drafts[ordinal];
      if (!draft) continue;
      const item: CollectedAttachment = {
        listed: publicAttachment(draft, id, ordinal),
        profile: draft.profile,
      };
      if (draft.downloadUrl) item.downloadUrl = draft.downloadUrl;
      collected.push(item);
      if (collected.length >= MAX_ATTACHMENTS) return collected;
    }
  }
  return collected;
}

function publicAttachment(draft: AttachmentDraft, messageIdValue: string, ordinal: number): AttachmentSummary {
  const summary: AttachmentSummary = {
    id: attachmentPublicId(messageIdValue, ordinal, draft.name, draft.fileKey),
    messageId: messageIdValue,
    name: draft.name,
  };
  if (draft.sizeBytes !== undefined) summary.sizeBytes = draft.sizeBytes;
  if (draft.type) summary.type = draft.type;
  return summary;
}

function draftsFromMessage(element: HTMLElement): AttachmentDraft[] {
  const merged = new Map<string, AttachmentDraft>();
  for (const draft of draftsFromRoot(element)) rememberDraft(merged, draft);
  const original = (element.dataset.original || "").trim().slice(0, MAX_ORIGINAL_LENGTH);
  const html = original.startsWith("&lt;") ? decodeEntities(original) : original;
  if (html.trim().startsWith("<")) {
    for (const draft of draftsFromRoot(htmlDocument(html).body)) rememberDraft(merged, draft);
  }
  return [...merged.values()];
}

function draftsFromRoot(root: ParentNode): AttachmentDraft[] {
  const seen = new Set<Element>();
  const drafts: AttachmentDraft[] = [];
  for (const profile of ATTACHMENT_PROFILES) {
    const elements = root.querySelectorAll<HTMLElement>(profile.selector);
    const candidates: HTMLElement[] = [];
    if (isElement(root) && root.matches(profile.selector)) candidates.push(root);
    candidates.push(...elements);
    for (const element of candidates) {
      if (seen.has(element)) continue;
      seen.add(element);
      const draft = draftFromElement(element, profile.name);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

function draftFromElement(element: HTMLElement, profile: string): AttachmentDraft | null {
  const details = parseJson(element.dataset.query);
  const fileKey = safeOpaqueKey(
    readField(details, "fileId") ??
      readField(details, "attachmentId") ??
      element.dataset.fileId ??
      element.dataset.fileid ??
      element.dataset.attachmentId,
  );
  const downloadUrl = firstAllowlistedUrl([
    element.dataset.downloadUrl,
    element.dataset.fileUrl,
    element.dataset.url,
    readField(details, "downloadUrl"),
    readField(details, "fileUrl"),
    readField(details, "url"),
    readField(details, "href"),
    readField(details, "downloadURL"),
    element.getAttribute("href"),
  ]);
  const name =
    safeFileName(readField(details, "fileName")) ||
    safeFileName(readField(details, "name")) ||
    safeFileName(element.dataset.fileName) ||
    safeFileName(element.dataset.filename) ||
    safeFileName(element.getAttribute("download")) ||
    (downloadUrl ? nameFromUrl(downloadUrl) : "");
  const sizeBytes = safeSize(
    readField(details, "fileSize") ?? readField(details, "size") ?? element.dataset.fileSize ?? element.dataset.size,
  );
  const type = safeFileType(
    readField(details, "fileType") ??
      readField(details, "contentType") ??
      readField(details, "mimeType") ??
      readField(details, "suffix") ??
      element.dataset.fileType ??
      element.dataset.type,
    name,
  );
  if (!name && sizeBytes === undefined && !type && !downloadUrl) return null;
  const draft: AttachmentDraft = {
    name: name || "attachment",
    profile,
    fileKey,
  };
  if (sizeBytes !== undefined) draft.sizeBytes = sizeBytes;
  if (type) draft.type = type;
  if (downloadUrl) draft.downloadUrl = downloadUrl;
  return draft;
}

function rememberDraft(map: Map<string, AttachmentDraft>, draft: AttachmentDraft): void {
  const key = [draft.name, draft.sizeBytes ?? "", draft.type ?? "", draft.fileKey].join("\u0000");
  const existing = map.get(key);
  if (!existing) {
    map.set(key, draft);
    return;
  }
  if (!existing.downloadUrl && draft.downloadUrl) {
    map.set(key, { ...existing, downloadUrl: draft.downloadUrl });
  }
}

function messageBelongsTo(element: HTMLElement, conversationId: string | undefined): boolean {
  if (!conversationId) return true;
  const metadata = parseJson(element.dataset.expinfo);
  const bound =
    element.dataset.conversationId ||
    element.dataset.cid ||
    asId(readField(metadata, "conversationId")) ||
    asId(readField(metadata, "cid"));
  return !bound || bound === conversationId;
}

function attachmentPublicId(messageIdValue: string, ordinal: number, name: string, fileKey: string): string {
  const hash = fnv32(`${messageIdValue}\0${ordinal}\0${name}\0${fileKey}`).toString(16).padStart(8, "0");
  const prefix = messageIdValue.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "m";
  return `att_${prefix}_${hash}`;
}

function isOpaqueAttachmentId(value: string): boolean {
  return /^att_[A-Za-z0-9_-]{4,64}$/.test(value);
}

export function allowlistedDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_000 || /[\s<>]/.test(trimmed) || trimmed.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== CLOUDDISK_HOST && !host.endsWith(`.${CLOUDDISK_HOST}`)) return null;
  return url.toString();
}

export function isExtensionBackgroundSender(
  sender: { id?: string; url?: string; tab?: unknown } | null | undefined,
  extensionId: string,
): boolean {
  if (!sender?.id || !extensionId || sender.id !== extensionId || sender.tab || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === extensionId && url.pathname === "/background.js";
  } catch {
    return false;
  }
}

function safeLocationHref(): string {
  try {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function firstAllowlistedUrl(values: unknown[]): string | undefined {
  for (const value of values) {
    const allowed = allowlistedDownloadUrl(value);
    if (allowed) return allowed;
  }
  return undefined;
}

function nameFromUrl(value: string): string {
  try {
    const last = new URL(value).pathname.split("/").filter(Boolean).pop() || "";
    return safeFileName(decodeURIComponent(last));
  } catch {
    return "";
  }
}

function safeOpaqueKey(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : "";
}

function safeFileName(value: unknown): string {
  const text = safeToken(value, "");
  if (!text || text.length > 180) return "";
  if (/[?#]|:\/\/|\\|clouddisk|cookie|token|signature/i.test(text)) return "";
  return text;
}

function safeSizeText(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") return "";
  const text = safeToken(value, "");
  if (!text || /[?#=&]|https?:|cookie|token/i.test(text)) return "";
  return text;
}

function safeSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 2_000_000_000) return Math.floor(value);
  if (typeof value === "string" && /^\d{1,12}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeFileType(value: unknown, name: string): string | undefined {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase().slice(0, 80);
    if (/^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,40}$/.test(text)) return text;
    if (/^[a-z0-9]{1,10}$/.test(text)) return text;
  }
  const extension = name.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase();
  return extension;
}

function redactTransportSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => (isSensitiveUrl(raw) ? "[attachment]" : raw))
    .replace(/\b(?:cookie|authorization|x-auth-token)\b\s*[:=]\s*\S+/gi, "[redacted]");
}

function isSensitiveUrl(value: string): boolean {
  return Boolean(allowlistedDownloadUrl(value) || /[?&#](?:token|sign|signature|auth|cookie|access_token|x-auth-token)=/i.test(value));
}

function fnv32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function inertHtml(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:src|srcset|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function stripActiveContent(doc: Document): void {
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta, noscript, template, svg, math").forEach((node) => {
    node.remove();
  });
  for (const element of doc.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "src" || name === "srcset" || name === "href") {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function decodeEntities(value: string): string {
  const doc = document.implementation.createHTMLDocument("");
  const node = doc.createElement("textarea");
  node.innerHTML = value;
  return node.value;
}

function htmlDocument(markup: string): Document {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:src|srcset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return doc;
}

function normalizeVisibleMessage(value: string): string {
  const lines = value.split("\n").map(normalizeText).filter(Boolean);
  const stamp = lines[1] || "";
  if (lines.length >= 3 && looksLikeTimestamp(stamp)) return lines.slice(2).join("\n");
  return lines.join("\n");
}

function locateSendControl(textarea: HTMLTextAreaElement): SendControl | undefined {
  const candidates = sendCandidates(composerContainer(textarea));
  candidates.sort((left, right) => sendRank(left) - sendRank(right));
  const element = candidates[0];
  if (!element) return undefined;
  return { element, name: sendProfileName(element), selector: sendSelectorDescription(element) };
}

function composerContainer(textarea: HTMLTextAreaElement): ParentNode {
  const scoped = textarea.closest("form, .message-box, [data-composer], [data-role='composer'], [role='form']");
  if (scoped) return scoped;
  let parent = textarea.parentElement;
  while (parent) {
    if (sendCandidates(parent).length > 0) return parent;
    if (parent === document.body) break;
    parent = parent.parentElement;
  }
  return document;
}

function sendCandidates(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button, input[type='button'], input[type='submit'], [role='button']")]
    .filter((element) => isSendControl(element));
}

function isSendControl(element: HTMLElement): boolean {
  if (!isVisible(element) || element.tagName === "TEXTAREA") return false;
  if (element.classList.contains("send-tool-button")) return true;
  const action = (element.dataset.action || element.dataset.command || element.dataset.type || "").toLowerCase();
  if (action === "send" || action === "submit-message") return true;
  return accessibleName(element).toLowerCase() === "send";
}

function sendRank(element: HTMLElement): number {
  if (element.classList.contains("send-tool-button")) return 0;
  const action = (element.dataset.action || element.dataset.command || "").toLowerCase();
  if (action === "send" || action === "submit-message") return 1;
  if ((element.getAttribute("aria-label") || "").trim().toLowerCase() === "send") return 2;
  return 3;
}

function sendProfileName(element: HTMLElement): string {
  if (element.classList.contains("send-tool-button")) return "send-tool-button";
  const action = (element.dataset.action || element.dataset.command || "").toLowerCase();
  if (action === "send" || action === "submit-message") return "data-action-send";
  if ((element.getAttribute("aria-label") || "").trim().toLowerCase() === "send") return "aria-label-send";
  if (element.tagName === "INPUT") return "input-send";
  return "visible-text-send";
}

function sendSelectorDescription(element: HTMLElement): string {
  const name = sendProfileName(element);
  if (name === "send-tool-button") return "button.send-tool-button";
  if (name === "data-action-send") return '[data-action="send"]';
  if (name === "aria-label-send") return '[aria-label="Send"]';
  if (name === "input-send") return 'input[value="Send"]';
  return 'button[accessible-name="Send"]';
}

function accessibleName(element: HTMLElement): string {
  const labelled = element.getAttribute("aria-label") || element.getAttribute("title") || "";
  if (labelled.trim()) return normalizeText(labelled);
  if (element.tagName === "INPUT") return normalizeText((element as HTMLInputElement).value || "");
  return normalizeText(readText(element));
}

function queryProfile<T extends Element>(profiles: readonly SelectorProfile[]): ProfileMatch<T> {
  let hidden: ProfileMatch<T> | undefined;
  for (const profile of profiles) {
    const elements = unique([...document.querySelectorAll<T>(profile.selector)]);
    if (!elements.length) continue;
    const visible = elements.filter(isVisible);
    if (visible.length) return { elements: visible, selector: profile.selector, name: profile.name };
    if (!hidden) hidden = { elements, selector: profile.selector, name: profile.name };
  }
  return hidden ?? { elements: [] };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  const rects = element.getClientRects() as ArrayLike<DOMRect | undefined>;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect && (rect.width > 0 || rect.height > 0)) return true;
  }
  return false;
}

function isElement(node: ParentNode): node is HTMLElement {
  return node.nodeType === 1 && "dataset" in node;
}

function isSelected(element: HTMLElement): boolean {
  return (
    element.classList.contains("selected") ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-current") === "true" ||
    element.dataset.selected === "true"
  );
}

function isEnabledControl(element: HTMLElement): boolean {
  if ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  if (element.classList.contains("gray") || element.classList.contains("disabled")) return false;
  return isVisible(element);
}

function conversationMatches(element: HTMLElement, conversationId: string): boolean {
  return [element.dataset.cid, element.dataset.aliId, element.dataset.conversationId].includes(conversationId);
}

function conversationId(element: HTMLElement): string {
  return element.dataset.cid || element.dataset.aliId || element.dataset.conversationId || "";
}

function isOutgoing(element: HTMLElement, selfId = detectSelfId()): boolean {
  const direction = (element.dataset.direction || element.dataset.messageDirection || "").trim().toLowerCase();
  if (OUTGOING_FLOW.has(direction)) return true;
  if (INCOMING_FLOW.has(direction)) return false;
  if (hasOutgoingMarker(element)) return true;
  if (hasIncomingMarker(element)) return false;
  const metadata = parseJson(element.dataset.expinfo);
  const flow = `${readField(metadata, "direction") || readField(metadata, "messageDirection") || readField(metadata, "flow") || ""}`
    .trim()
    .toLowerCase();
  if (OUTGOING_FLOW.has(flow)) return true;
  if (INCOMING_FLOW.has(flow)) return false;
  const fromSelf = readField(metadata, "fromSelf") ?? readField(metadata, "self");
  if (fromSelf === true || fromSelf === "true" || fromSelf === 1) return true;
  if (fromSelf === false || fromSelf === "false" || fromSelf === 0) return false;
  const sender = asId(readField(metadata, "senderId"));
  return Boolean(sender && selfId && sender === selfId);
}

function hasOutgoingMarker(element: HTMLElement): boolean {
  return element.classList.contains("item-right") || element.classList.contains("message-right") || element.classList.contains("self");
}

function hasIncomingMarker(element: HTMLElement): boolean {
  return element.classList.contains("item-left") || element.classList.contains("message-left");
}

function isUnseenOutgoing(element: HTMLElement, normalized: string, snapshot: MessageSnapshot, selfId: string): boolean {
  if (!isOutgoing(element, selfId)) return false;
  const text = normalizeText(extractMessageText(element.dataset.original || "", element));
  if (text !== normalized) return false;
  const id = messageId(element);
  if (id) return !snapshot.ids.has(id);
  return !snapshot.elements.has(element);
}

function detectSelfId(): string {
  const fromRoot = document.documentElement?.dataset.selfId || document.body?.dataset.selfId || "";
  if (fromRoot.trim()) return fromRoot.trim();
  for (const element of queryProfile<HTMLElement>(MESSAGE_PROFILES).elements) {
    if (!hasOutgoingMarker(element)) continue;
    const sender = asId(readField(parseJson(element.dataset.expinfo), "senderId"));
    if (sender) return sender;
  }
  return "";
}

function messageId(element: HTMLElement): string {
  const fromData = element.dataset.messageId || element.dataset.mid || element.dataset.msgId || "";
  if (fromData.trim()) return fromData.trim().slice(0, 200);
  return asId(readField(parseJson(element.dataset.expinfo), "messageId"));
}

function messageSignature(element: HTMLElement): string {
  return [
    messageId(element),
    element.dataset.original || "",
    element.dataset.direction || "",
    hasOutgoingMarker(element) ? "1" : "0",
  ].join("\u0000");
}

function messagePaneBusy(): boolean {
  const pane = messagePane();
  const busy = pane.querySelector('[aria-busy="true"], [data-loading="true"], [data-state="loading"]');
  return Boolean(busy && isVisible(busy));
}

function messagePane(): ParentNode {
  return (
    document.querySelector(".message-box") ||
    document.querySelector("[data-composer]") ||
    document.querySelector("textarea")?.closest("section, main, form") ||
    document
  );
}

function textOf(root: ParentNode, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    const value = element ? readText(element) : "";
    if (value.trim()) return normalizeText(value);
  }
  return "";
}

function readText(element: HTMLElement): string {
  return element.innerText ?? element.textContent ?? "";
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

function safeToken(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return text || fallback;
}

function parseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readField(record: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

function asId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeMessageTimestamp(value: unknown): string | undefined {
  const milliseconds = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : undefined;
}

function normalizeListTimestamp(visible: string, milliseconds: string | undefined): string | undefined {
  const numeric = Number(milliseconds);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : visible || undefined;
}

function looksLikeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/.test(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : min, max));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(textarea) as object;
  const descriptor =
    Object.getOwnPropertyDescriptor(prototype, "value") ??
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  const setter = descriptor?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
  const view = textarea.ownerDocument.defaultView;
  const Input = view?.InputEvent ?? InputEvent;
  const EventCtor = view?.Event ?? Event;
  try {
    textarea.dispatchEvent(new Input("input", { bubbles: true, inputType: "insertText", data: value }));
  } catch {
    textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
  }
  textarea.dispatchEvent(new EventCtor("change", { bubbles: true }));
}

async function waitForAny<T extends Element>(
  profiles: readonly SelectorProfile[],
  timeout: number,
  label: string,
  pollMs: number,
): Promise<T> {
  const existing = queryProfile<T>(profiles).elements[0];
  if (existing) return existing;
  return waitForValue(
    () => queryProfile<T>(profiles).elements[0],
    timeout,
    `Could not find a visible ${label}. Tried: ${profiles.map((profile) => profile.name).join(", ")}.`,
    pollMs,
  );
}

async function waitUntil(condition: () => boolean, timeout: number, error: string, pollMs: number): Promise<void> {
  await waitForValue(() => (condition() ? true : undefined), timeout, error, pollMs);
}

async function waitForValue<T>(read: () => T | undefined, timeout: number, error: string, pollMs: number): Promise<T> {
  const root = document.documentElement;
  if (!root) throw new Error(error);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (value: T | undefined, failure?: Error) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (failure) reject(failure);
      else resolve(value as T);
    };
    const check = () => {
      if (settled) return;
      try {
        const value = read();
        if (value !== undefined) finish(value);
      } catch (cause) {
        finish(undefined, cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    poll = setInterval(check, Math.max(10, pollMs));
    timer = setTimeout(() => finish(undefined, new Error(error)), timeout);
    check();
  });
}
