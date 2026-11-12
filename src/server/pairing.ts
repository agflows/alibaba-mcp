import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isValidPairingToken } from "../shared/protocol.js";

export type PairingState = {
  token: string;
  claimPairing: () => Promise<boolean>;
};

export function resolvePairingDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ALIBABA_MCP_STATE_DIR?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("ALIBABA_MCP_STATE_DIR must be absolute.");
    return path.resolve(override);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".config"), "alibaba-mcp");
}

export async function loadOrCreatePairingState(directory: string): Promise<PairingState> {
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, "pairing.json");
  let record: PairingRecord;
  try {
    record = await readState(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
    record = { version: 1, token: randomBytes(32).toString("base64url"), paired: false };
    const created = await createState(file, record);
    if (!created) record = await readState(file);
  }
  let paired = record.paired;
  let claiming = false;
  return {
    token: record.token,
    claimPairing: async () => {
      if (paired || claiming) return false;
      claiming = true;
      try {
        await replaceState(file, { ...record, paired: true });
        paired = true;
        return true;
      } finally {
        claiming = false;
      }
    },
  };
}

type PairingRecord = { version: 1; token: string; paired: boolean };

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pairing state must be a private directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Pairing state is not owned by this user.");
  if ((stat.mode & 0o077) !== 0) throw new Error("Pairing state directory permissions must be 0700.");
}

async function createState(file: string, record: PairingRecord): Promise<boolean> {
  const handle = await open(file, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!handle) return false;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function replaceState(file: string, record: PairingRecord): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readState(file: string): Promise<PairingRecord> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Pairing state file is invalid.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Pairing state file is not owned by this user.");
  if ((stat.mode & 0o077) !== 0) throw new Error("Pairing state file permissions must be 0600.");
  if (stat.size > 4096) throw new Error("Pairing state file is invalid.");
  const parsed = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; token?: unknown; paired?: unknown };
  if (parsed.version !== 1 || typeof parsed.token !== "string" || !isValidPairingToken(parsed.token)) {
    throw new Error("Pairing state file is invalid.");
  }
  // A secret written before the claim flag existed was already issued.
  const paired = typeof parsed.paired === "boolean" ? parsed.paired : true;
  return { version: 1, token: parsed.token, paired };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
