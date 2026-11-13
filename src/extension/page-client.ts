const REQUEST_SOURCE = "alibaba-mcp-request";
const RESPONSE_SOURCE = "alibaba-mcp-response";
const PAGE_ORIGIN = "https://message.alibaba.com";

export function callMessengerPage<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  if (location.origin !== PAGE_ORIGIN) throw new Error("The active page is not Alibaba Messages.");
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("The Alibaba tab did not respond. Reload the messenger page and try again."));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (event.origin !== PAGE_ORIGIN || event.source !== window) return;
      const data = event.data as { source?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown } | null;
      if (!data || data.source !== RESPONSE_SOURCE || data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.ok === true) {
        resolve(data.result as T);
        return;
      }
      const error = typeof data.error === "string" ? data.error.trim().slice(0, 300) : "";
      reject(new Error(error || "Alibaba request failed."));
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: REQUEST_SOURCE, id, method, params }, PAGE_ORIGIN);
  });
}
