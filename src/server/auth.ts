import { createHash, timingSafeEqual } from "node:crypto";
import { BRIDGE_PORT, isValidExtensionId, isValidPairingToken } from "../shared/protocol.js";

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConfigError";
  }
}

export interface BridgeConfig {
  port: number;
  token: string;
  extensionId: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

/** Hash both values so every accepted token length compares in constant time. */
export function tokensMatch(expected: string, actual: string): boolean {
  if (!isValidPairingToken(expected) || !isValidPairingToken(actual)) return false;
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(actual).digest();
  return timingSafeEqual(left, right);
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return BRIDGE_PORT;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_PORT must be an integer from 1024 to 65535, or 0 for an ephemeral test port.",
    );
  }
  const port = Number(raw);
  if (port !== 0 && (port < 1024 || port > 65535)) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_PORT must be an integer from 1024 to 65535, or 0 for an ephemeral test port.",
    );
  }
  return port;
}

export function readBridgeConfigFromEnv(env: NodeJS.ProcessEnv): BridgeConfig {
  const token = env.ALIBABA_MCP_TOKEN?.trim() ?? "";
  const extensionId = env.ALIBABA_MCP_EXTENSION_ID?.trim() ?? "";
  if (!token) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_TOKEN is missing. Open the alibaba-mcp extension, choose Copy agent setup, and paste that configuration. The token is a local secret.",
    );
  }
  if (!isValidPairingToken(token)) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_TOKEN is not a valid pairing token. Rotate the token in the extension and copy the setup again.",
    );
  }
  if (!extensionId) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_EXTENSION_ID is missing. Copy the agent setup from the extension so the server accepts only that extension.",
    );
  }
  if (!isValidExtensionId(extensionId)) {
    throw new BridgeConfigError(
      "ALIBABA_MCP_EXTENSION_ID must be the 32-character id from the extension setup, using lowercase letters a-p.",
    );
  }
  return { token, extensionId, port: parsePort(env.ALIBABA_MCP_PORT) };
}
