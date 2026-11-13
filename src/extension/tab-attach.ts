export function messengerTabUnloaded(tab: { discarded?: boolean; status?: string }): boolean {
  return tab.discarded === true || tab.status === "unloaded";
}

export function messengerScriptMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Receiving end does not exist|Extension context invalidated|The message port closed|The tab was discarded/i.test(message);
}
