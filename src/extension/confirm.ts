const title = document.querySelector<HTMLElement>("[data-conversation-title]")!;
const id = document.querySelector<HTMLElement>("[data-conversation-id]")!;
const text = document.querySelector<HTMLElement>("[data-message-text]")!;
const timeout = document.querySelector<HTMLElement>("[data-timeout]")!;
const error = document.querySelector<HTMLElement>("[data-error]")!;
const approve = document.querySelector<HTMLButtonElement>("[data-approve]")!;
const cancel = document.querySelector<HTMLButtonElement>("[data-cancel]")!;

let approvalId = "";
let seconds = 25;
const ticker = window.setInterval(() => {
  seconds -= 1;
  timeout.textContent = `This request closes automatically in ${Math.max(0, seconds)} seconds.`;
  if (seconds <= 0) window.clearInterval(ticker);
}, 1_000);

void load();
approve.addEventListener("click", () => void decide(true));
cancel.addEventListener("click", () => void decide(false));

async function load(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: "get-send-approval" });
    const approval = result?.approval;
    if (!result?.ok || !approval || typeof approval.id !== "string") {
      throw new Error(typeof result?.error === "string" ? result.error : "This send request is no longer pending.");
    }
    approvalId = approval.id;
    title.textContent = typeof approval.conversationTitle === "string" ? approval.conversationTitle : "Alibaba conversation";
    id.textContent = typeof approval.conversationId === "string" ? approval.conversationId : "";
    text.textContent = typeof approval.text === "string" ? approval.text : "";
    approve.disabled = false;
    cancel.focus();
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : "The send request could not be loaded.");
  }
}

async function decide(approved: boolean): Promise<void> {
  if (!approvalId) return;
  approve.disabled = true;
  cancel.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "resolve-send-approval", id: approvalId, approved });
    if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "The decision could not be saved.");
    window.close();
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : "The decision could not be saved.");
    approve.disabled = false;
    cancel.disabled = false;
  }
}

function showError(message: string): void {
  error.hidden = false;
  error.textContent = message;
  timeout.hidden = true;
  approve.disabled = true;
}
