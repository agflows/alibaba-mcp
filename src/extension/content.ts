import { AlibabaAdapter, isExtensionBackgroundSender } from "./alibaba-adapter.js";

const adapter = new AlibabaAdapter();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "alibaba-mcp-request") return;
  const method = typeof (message as { method?: unknown }).method === "string" ? (message as { method: string }).method : "";
  void Promise.resolve()
    .then(() => handle(method, asParams((message as { params?: unknown }).params), sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

async function handle(
  method: string,
  params: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (method) {
    case "get_page_status":
      return adapter.health();
    case "list_conversations":
      return adapter.listConversations(optionalLimit(params.limit, 30), optionalSearch(params.search));
    case "get_conversation":
      return adapter.getConversation(requiredId(params.conversationId), optionalLimit(params.limit, 100));
    case "list_attachments":
      return adapter.listAttachments(requiredId(params.conversationId));
    case "prepare_attachment":
      if (!isExtensionBackgroundSender(sender, chrome.runtime.id)) {
        throw new Error("Attachment download URLs are available only to the extension background.");
      }
      return adapter.prepareAttachment(requiredId(params.conversationId), requiredAttachmentId(params.attachmentId));
    case "send_message":
      return adapter.sendMessage(requiredId(params.conversationId), requiredText(params.text));
    default:
      throw new Error(`Unsupported Alibaba operation: ${method || "unknown"}`);
  }
}

function asParams(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Request params must be an object.");
  return value as Record<string, unknown>;
}

function optionalLimit(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("limit must be a finite number.");
  return value;
}

function optionalSearch(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error("search must be a string.");
  return value;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Conversation id is required.");
  const id = value.trim();
  if (id.length > 300) throw new Error("Conversation id is too long.");
  return id;
}

function requiredAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^att_[A-Za-z0-9_-]{4,64}$/.test(value)) {
    throw new Error("Attachment id is required.");
  }
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Message text is required.");
  if (value.trim().length > 10_000) throw new Error("Message text is too long.");
  return value;
}
