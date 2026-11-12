import { formatConversationForClipboard, type AccessMode } from "../shared/protocol.js";

const statusDot = document.querySelector<HTMLElement>("[data-status-dot]")!;
const statusText = document.querySelector<HTMLElement>("[data-status-text]")!;
const copyConversationButton = document.querySelector<HTMLButtonElement>("[data-copy-conversation]")!;
const installButton = document.querySelector<HTMLAnchorElement>("[data-install]")!;
const companionCopy = document.querySelector<HTMLElement>("[data-companion-copy]")!;
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-access]")];
let currentAccess: AccessMode = "write";
let conversationCopyPending = false;

void refresh();
const poll = window.setInterval(() => {
  void refresh();
}, 1500);
window.addEventListener("pagehide", () => window.clearInterval(poll));

copyConversationButton.addEventListener("click", async () => {
  if (conversationCopyPending || currentAccess === "none") return;
  conversationCopyPending = true;
  copyConversationButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "copy-conversation" });
    if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "Could not read conversation");
    const text = formatConversationForClipboard(result.conversation);
    await navigator.clipboard.writeText(text);
    const label = copyConversationButton.querySelector("[data-copy-conversation-label]")!;
    label.textContent = "Conversation copied";
    copyConversationButton.classList.add("copied");
    window.setTimeout(() => {
      label.textContent = "Copy conversation";
      copyConversationButton.classList.remove("copied");
    }, 1600);
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : "Could not copy conversation";
  } finally {
    conversationCopyPending = false;
    updateCopyConversationButton();
  }
});

for (const [index, option] of options.entries()) {
  option.addEventListener("click", () => void selectAccess(option));
  option.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    const nextOption = options[next]!;
    nextOption.focus();
    void selectAccess(nextOption);
  });
}

async function selectAccess(option: HTMLButtonElement): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: "set-access", accessMode: option.dataset.access });
  if (result?.ok) renderAccess(result.accessMode as AccessMode);
}

async function refresh(): Promise<void> {
  try {
    const config = await chrome.runtime.sendMessage({ type: "get-config" });
    if (!config) return;
    renderAccess(config.accessMode as AccessMode);
    const connected = Boolean(config.bridgeConnected);
    const unavailable = Boolean(config.pairingUnavailable) && !connected;
    statusDot.dataset.connected = String(connected);
    statusText.textContent = connected
      ? "Securely connected"
      : unavailable
        ? "Companion already paired"
        : "Waiting for local companion";
    companionCopy.textContent = connected
      ? "Secure pairing is active."
      : unavailable
        ? "Reset the companion pairing state, then restart the agent."
        : "Install the companion once; pairing and agent registration are automatic.";
    installButton.hidden = connected || unavailable;
  } catch {
    statusText.textContent = "Extension unavailable";
  }
}

function renderAccess(mode: AccessMode): void {
  currentAccess = mode;
  updateCopyConversationButton();
  for (const option of options) {
    const selected = option.dataset.access === mode;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
    option.tabIndex = selected ? 0 : -1;
  }
}

function updateCopyConversationButton(): void {
  copyConversationButton.disabled = conversationCopyPending || currentAccess === "none";
  copyConversationButton.title = currentAccess === "none"
    ? "Set chat access to Read or Read & write first"
    : "Copy the selected Alibaba conversation";
}
