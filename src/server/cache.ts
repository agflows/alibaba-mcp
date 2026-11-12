import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, rm, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ATTACHMENT_CACHE_TTL_MS, ATTACHMENT_TOO_LARGE, sanitizeFileName } from "../shared/attachments.js";

const PARTIAL_TTL_MS = 15 * 60 * 1000;

export function resolveCacheDir(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return path.join(homedir(), ".cache", "alibaba-mcp", "attachments");
  if (!path.isAbsolute(configured)) throw new Error("ALIBABA_MCP_CACHE_DIR must be an absolute path.");
  return path.resolve(configured);
}

export class AttachmentCache {
  private constructor(
    readonly directory: string,
    private readonly ttlMs: number,
  ) {}

  static async open(directory: string, ttlMs = ATTACHMENT_CACHE_TTL_MS): Promise<AttachmentCache> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Attachment cache must be a private directory.");
    }
    await chmod(directory, 0o700);
    const secured = await lstat(directory);
    if (typeof process.getuid === "function" && secured.uid !== process.getuid()) {
      throw new Error("Attachment cache directory is not owned by the current user.");
    }
    if ((secured.mode & 0o077) !== 0) throw new Error("Attachment cache directory is not private.");
    return new AttachmentCache(directory, ttlMs);
  }

  async sweep(now = Date.now()): Promise<number> {
    return this.removeWhere((stat, name) => {
      const age = now - Number(stat.mtimeMs);
      if (name.endsWith(".partial") || name.startsWith(".")) return age > PARTIAL_TTL_MS;
      return age > this.ttlMs;
    });
  }

  async clear(): Promise<number> {
    return this.removeWhere(() => true);
  }

  async begin(name: string, maxBytes: number): Promise<CacheWrite> {
    await this.sweep();
    const id = randomUUID();
    const safeName = sanitizeFileName(name);
    const partial = path.join(this.directory, `.${id}.partial`);
    const finalPath = path.join(this.directory, `${id}-${safeName}`);
    assertInside(this.directory, partial);
    assertInside(this.directory, finalPath);
    const handle = await open(partial, "wx", 0o600);
    await chmod(partial, 0o600);
    return new CacheWrite(handle, partial, finalPath, safeName, maxBytes);
  }

  private async removeWhere(match: (stat: Awaited<ReturnType<typeof lstat>>, name: string) => boolean): Promise<number> {
    let removed = 0;
    const names = await readdir(this.directory);
    for (const name of names) {
      const target = path.join(this.directory, name);
      if (!inside(this.directory, target)) continue;
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (!match(stat, name)) continue;
      await rm(target, { force: true });
      removed += 1;
    }
    return removed;
  }
}

export class CacheWrite {
  private bytes = 0;
  private readonly hash = createHash("sha256");
  private closed = false;
  private finished = false;

  constructor(
    private handle: FileHandle | null,
    private readonly partial: string,
    private readonly finalPath: string,
    readonly name: string,
    private readonly maxBytes: number,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.handle || this.finished) throw new Error("Attachment download failed.");
    if (this.bytes + chunk.byteLength > this.maxBytes) throw new Error(ATTACHMENT_TOO_LARGE);
    this.hash.update(chunk);
    let view = chunk;
    while (view.byteLength > 0) {
      const result = await this.handle.write(view);
      if (result.bytesWritten <= 0) throw new Error("Attachment download failed.");
      view = view.subarray(result.bytesWritten);
    }
    this.bytes += chunk.byteLength;
  }

  async finish(): Promise<{ path: string; name: string; byteSize: number; sha256: string }> {
    if (!this.handle || this.finished) throw new Error("Attachment download failed.");
    await this.handle.sync();
    await this.handle.close();
    this.handle = null;
    await chmod(this.partial, 0o600);
    await rename(this.partial, this.finalPath);
    this.finished = true;
    await chmod(this.finalPath, 0o600);
    return {
      path: this.finalPath,
      name: this.name,
      byteSize: this.bytes,
      sha256: this.hash.digest("hex"),
    };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle?.close().catch(() => {});
    this.handle = null;
    await rm(this.partial, { force: true }).catch(() => {});
    if (this.finished) await rm(this.finalPath, { force: true }).catch(() => {});
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInside(root: string, target: string): void {
  if (!inside(root, target)) throw new Error("Attachment cache path escaped its directory.");
}

export async function ageFile(file: string, mtimeMs: number): Promise<void> {
  const date = new Date(mtimeMs);
  await utimes(file, date, date);
}
