import { formatAgentSetup, type AccessMode } from "../shared/protocol.js";

const statusDot = document.querySelector<HTMLElement>("[data-status-dot]")!;
const statusText = document.querySelector<HTMLElement>("[data-status-text]")!;
const copyButton = document.querySelector<HTMLButtonElement>("[data-copy]")!;
const rotateButton = document.querySelector<HTMLButtonElement>("[data-rotate]")!;
const options = [...document.querySelectorAll<HTMLButtonElement>("[data-access]")];
let bridgeToken = "";

void refresh();
const poll = window.setInterval(() => {
  void refresh();
}, 1500);
window.addEventListener("pagehide", () => window.clearInterval(poll));

copyButton.addEventListener("click", async () => {
  if (!bridgeToken) return;
  const instructions = formatAgentSetup({
    token: bridgeToken,
    extensionId: chrome.runtime.id,
  });
  try {
    await navigator.clipboard.writeText(instructions);
  } catch {
    statusText.textContent = "Clipboard unavailable";
    return;
  }
  const label = copyButton.querySelector("[data-copy-label]")!;
  label.textContent = "Copied";
  copyButton.classList.add("copied");
  window.setTimeout(() => {
    label.textContent = "Copy agent setup";
    copyButton.classList.remove("copied");
  }, 1600);
});

rotateButton.addEventListener("click", async () => {
  if (!window.confirm("Rotate the pairing token? Agents stay disconnected until you copy the new setup.")) return;
  const result = await chrome.runtime.sendMessage({ type: "rotate-token" });
  if (!result?.ok || typeof result.bridgeToken !== "string") {
    statusText.textContent = "Could not rotate token";
    return;
  }
  bridgeToken = result.bridgeToken;
  copyButton.disabled = false;
  statusText.textContent = "New token ready to copy";
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
    if (!config || typeof config.bridgeToken !== "string") return;
    bridgeToken = config.bridgeToken;
    copyButton.disabled = bridgeToken.length === 0;
    renderAccess(config.accessMode as AccessMode);
    const connected = Boolean(config.bridgeConnected);
    statusDot.dataset.connected = String(connected);
    if (statusText.textContent === "New token ready to copy" || statusText.textContent === "Clipboard unavailable") return;
    statusText.textContent = connected ? "Agent bridge connected" : "Waiting for local agent";
  } catch {
    statusText.textContent = "Extension unavailable";
  }
}

function renderAccess(mode: AccessMode): void {
  for (const option of options) {
    const selected = option.dataset.access === mode;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
    option.tabIndex = selected ? 0 : -1;
  }
}
