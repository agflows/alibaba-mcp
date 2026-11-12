export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;
export const HEARTBEAT_MS = 20_000;
export const PONG_TIMEOUT_MS = 12_000;
export const CONNECT_TIMEOUT_MS = 5_000;
export const KEEPALIVE_ALARM = "alibaba-mcp-keepalive";
/** Chrome 120 and newer honors 30 seconds. Older Chrome raises this to one minute. */
export const KEEPALIVE_PERIOD_MINUTES = 0.5;

export function nextReconnectDelay(current: number): number {
  if (!Number.isFinite(current) || current < RECONNECT_MIN_MS) return RECONNECT_MIN_MS;
  return Math.min(Math.round(current * 1.7), RECONNECT_MAX_MS);
}

/** WebSocket readyState: 0 connecting, 1 open, 2 closing, 3 closed. */
export function socketNeedsReconnect(readyState: number | null | undefined): boolean {
  return readyState == null || readyState >= 2;
}
