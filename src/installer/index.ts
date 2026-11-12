import { mkdir, readFile, rename, writeFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidPairingToken } from "../shared/protocol.js";

const command = process.argv[2] ?? "install";
const configuredPath = process.env.ALIBABA_MCP_CURSOR_CONFIG?.trim();
if (configuredPath && !path.isAbsolute(configuredPath)) throw new Error("ALIBABA_MCP_CURSOR_CONFIG must be absolute.");
const configPath = configuredPath ? path.resolve(configuredPath) : path.join(homedir(), ".cursor", "mcp.json");
const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/index.js");

if (command === "install") await update(true);
else if (command === "uninstall") await update(false);
else if (command === "status") await status();
else {
  console.error("Usage: alibaba-mcp-setup [install|status|uninstall]");
  process.exitCode = 2;
}

async function update(install: boolean): Promise<void> {
  const config = await readConfig();
  const servers = object(config.mcpServers);
  if (install) {
    const previous = object(servers.alibaba);
    const env = relayEnv(previous);
    servers.alibaba = { command: process.execPath, args: [serverPath], ...(env ? { env } : {}) };
  } else {
    delete servers.alibaba;
  }
  config.mcpServers = servers;
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (await exists(configPath)) {
    const backup = `${configPath}.alibaba-mcp.${Date.now()}.bak`;
    await copyFile(configPath, backup, constants.COPYFILE_EXCL);
    console.log(`Backup: ${backup}`);
  }
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  console.log(install ? "alibaba-mcp was registered with Cursor." : "alibaba-mcp was removed from Cursor.");
  console.log("Restart Cursor to apply the change.");
}

async function status(): Promise<void> {
  const config = await readConfig();
  const entry = object(config.mcpServers).alibaba;
  const installed = Boolean(entry && typeof entry === "object");
  console.log(JSON.stringify({ installed, client: "Cursor", configPath }, null, 2));
  if (!installed) process.exitCode = 1;
}

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cursor MCP configuration is not an object.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function relayEnv(previous: Record<string, any>): { ALIBABA_MCP_PROXY_TOKEN: string } | undefined {
  const fromEnv = process.env.ALIBABA_MCP_PROXY_TOKEN?.trim() ?? "";
  if (fromEnv) {
    if (!isValidPairingToken(fromEnv)) throw new Error("Relay secret is missing or too weak.");
    return { ALIBABA_MCP_PROXY_TOKEN: fromEnv };
  }
  const existing = previous.env?.ALIBABA_MCP_PROXY_TOKEN;
  if (typeof existing === "string" && isValidPairingToken(existing)) return { ALIBABA_MCP_PROXY_TOKEN: existing };
  return undefined;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

async function exists(file: string): Promise<boolean> {
  try { await readFile(file); return true; } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
