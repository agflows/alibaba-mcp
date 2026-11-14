import { formatConversationForClipboard, type AccessMode } from "../shared/protocol.js";

const statusDot = document.querySelector<HTMLElement>("[data-status-dot]")!;
const statusText = document.querySelector<HTMLElement>("[data-status-text]")!;
const copyConversationButton = document.querySelector<HTMLButtonElement>("[data-copy-conversation]")!;
const copySetupButton = document.querySelector<HTMLButtonElement>("[data-copy-setup]")!;
const installButton = document.querySelector<HTMLAnchorElement>("[data-install]")!;
const companionCopy = document.querySelector<HTMLElement>("[data-companion-copy]")!;
const disconnectClientsButton = document.querySelector<HTMLButtonElement>("[data-disconnect-clients]")!;
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-access]")];
let currentAccess: AccessMode = "read";
let conversationCopyPending = false;
let setupCopyPending = false;

void refresh();
const poll = window.setInterval(() => {
  void refresh();
}, 1500);
window.addEventListener("pagehide", () => window.clearInterval(poll));

copySetupButton.addEventListener("click", async () => {
  if (setupCopyPending) return;
  setupCopyPending = true;
  copySetupButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "copy-setup" });
    if (!result?.ok || typeof result.text !== "string") throw new Error(typeof result?.error === "string" ? result.error : "Could not copy instructions");
    await navigator.clipboard.writeText(result.text);
    const label = copySetupButton.querySelector("[data-copy-setup-label]")!;
    label.textContent = "Instructions copied";
    copySetupButton.classList.add("copied");
    window.setTimeout(() => {
      label.textContent = "Copy instructions";
      copySetupButton.classList.remove("copied");
    }, 1600);
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : "Could not copy instructions";
  } finally {
    setupCopyPending = false;
    copySetupButton.disabled = false;
  }
});

disconnectClientsButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Disconnect every MCP client? Existing connector credentials will stop working. You will need to copy the new instructions and update the local attachment companion.",
  );
  if (!confirmed) return;
  disconnectClientsButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "disconnect-clients" });
    if (!result?.ok) throw new Error(typeof result?.error === "string" ? result.error : "Clients could not be disconnected");
    statusText.textContent = "Clients disconnected";
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : "Clients could not be disconnected";
  } finally {
    disconnectClientsButton.disabled = false;
  }
});

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
      ? "Relay connected"
      : unavailable
        ? "Local companion already paired"
        : "Connecting to relay";
    companionCopy.textContent = connected
      ? "The hosted relay is reachable. Copy the instructions into Claude, ChatGPT, or Cursor."
      : unavailable
        ? "Reset the local companion pairing state, then restart it."
        : "Keep the messenger tab open while the extension reconnects.";
    installButton.hidden = false;
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
