import {
  createMessenger,
  messengerSendCall,
  messengerSendPayload,
  MessengerUnavailable,
  type MessengerDeps,
  type MessengerResponse,
  type MessengerSendPayload,
} from "./messenger-api.js";

const REQUEST_SOURCE = "alibaba-mcp-request";
const RESPONSE_SOURCE = "alibaba-mcp-response";
const INSTALLED = "__alibabaMcpPageApi";

interface PageWindow extends Window {
  __alibabaMcpPageApi?: boolean;
  __conversationListFullData__?: unknown;
  IcbuIM?: {
    IMBaaSSDK?: {
      default?: SdkDefault;
    };
  };
}

interface SendService {
  messageServiceHttp?: { sendUIMessages?: (payload: MessengerSendPayload) => unknown };
}

interface SdkDefault {
  getMessageServiceV2?: () => SendService;
  getMessageService?: () => SendService;
}

interface PageRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const page = window as PageWindow;
if (!page[INSTALLED]) {
  page[INSTALLED] = true;
  const messenger = createMessenger(pageDeps());
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = parseRequest(event.data);
    if (!request) return;
    void handle(request)
      .then((result) => reply(request.id, { ok: true, result }))
      .catch((error: unknown) => reply(request.id, { ok: false, error: publicError(error) }));
  });

  async function handle(request: PageRequest): Promise<unknown> {
    if (location.hostname !== "message.alibaba.com") throw new Error("The active page is not Alibaba Messages.");
    switch (request.method) {
      case "messenger_status":
        return messenger.status();
      case "list_conversations":
        try {
          return messenger.listConversations(numberParam(request.params.limit, 30), stringParam(request.params.search, ""));
        } catch (error) {
          if (error instanceof MessengerUnavailable) return null;
          throw error;
        }
      case "get_conversation":
        return messenger.getConversation(requiredString(request.params.conversationId, "Conversation id is required."), numberParam(request.params.limit, 100));
      case "send_message":
        return messenger.sendMessage(
          requiredString(request.params.conversationId, "Conversation id is required."),
          requiredString(request.params.text, "Message text is required."),
        );
      default:
        throw new Error("Unsupported Alibaba operation.");
    }
  }
}

function pageDeps(): MessengerDeps {
  return {
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) }) as Promise<MessengerResponse>,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    conversationRecords: () => page.__conversationListFullData__,
    canSend: () => messengerSendCall(messageService() ?? {}) !== null,
    sendText: (cid, content) => {
      const send = messengerSendCall(messageService() ?? {});
      if (!send) {
        throw new MessengerUnavailable("Alibaba's message service is not loaded in this tab. Reload the messenger page and try again.");
      }
      return send(messengerSendPayload(cid, content, page.__conversationListFullData__));
    },
  };
}

function messageService(): SendService | null {
  const sdk = page.IcbuIM?.IMBaaSSDK?.default;
  const getService = sdk?.getMessageServiceV2 ?? sdk?.getMessageService;
  if (!sdk || typeof getService !== "function") return null;
  const service = getService.call(sdk);
  if (!service || typeof service !== "object") return null;
  return service;
}

function parseRequest(value: unknown): PageRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source !== REQUEST_SOURCE) return null;
  if (typeof record.id !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(record.id)) return null;
  if (typeof record.method !== "string" || record.method.length > 80) return null;
  const params = record.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  return { id: record.id, method: record.method, params: params as Record<string, unknown> };
}

function reply(id: string, payload: { ok: true; result: unknown } | { ok: false; error: string }): void {
  window.postMessage({ source: RESPONSE_SOURCE, id, ...payload }, location.origin);
}

function publicError(error: unknown): string {
  if (error instanceof MessengerUnavailable) return error.message.slice(0, 300);
  const message = error instanceof Error ? error.message : "Alibaba request failed.";
  const cleaned = message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9+/_=~.-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Alibaba request failed.").slice(0, 300);
}

function numberParam(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("limit must be a finite number.");
  return value;
}

function stringParam(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  if (typeof value !== "string") throw new Error("search must be a string.");
  if (value.length > 200) throw new Error("search is too long.");
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  if (value.length > 10_000) throw new Error("Request value is too long.");
  return value;
}
