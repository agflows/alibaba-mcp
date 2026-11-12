import { createHmac, timingSafeEqual } from "node:crypto";
import { BRIDGE_PORT, DEVELOPMENT_EXTENSION_ID, isValidExtensionId, isValidPairingToken } from "../shared/protocol.js";

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConfigError";
  }
}

export interface BridgeConfig {
  port: number;
  extensionIds: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

export function authProof(token: string, challenge: string): string {
  if (!isValidPairingToken(token) || !isValidPairingToken(challenge)) return "";
  return createHmac("sha256", token).update(challenge).digest("base64url");
}

export function proofsMatch(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return BRIDGE_PORT;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) throw new BridgeConfigError("ALIBABA_MCP_PORT must be an integer from 1024 to 65535, or 0 for tests.");
  const port = Number(raw);
  if (port !== 0 && (port < 1024 || port > 65535)) {
    throw new BridgeConfigError("ALIBABA_MCP_PORT must be an integer from 1024 to 65535, or 0 for tests.");
  }
  return port;
}

export function readBridgeConfigFromEnv(env: NodeJS.ProcessEnv): BridgeConfig {
  const configured = (env.ALIBABA_MCP_EXTENSION_IDS ?? env.ALIBABA_MCP_EXTENSION_ID ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const extensionIds = [...new Set([DEVELOPMENT_EXTENSION_ID, ...configured])];
  if (extensionIds.some((id) => !isValidExtensionId(id))) {
    throw new BridgeConfigError("Configured extension ids must be 32 lowercase letters from a-p.");
  }
  return { port: parsePort(env.ALIBABA_MCP_PORT), extensionIds };
}
