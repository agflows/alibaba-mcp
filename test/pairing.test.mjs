import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreatePairingState, resolvePairingDir } from "../.test-build/app.mjs";

test("pairing state is generated once, private, and claimable once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alibaba-pairing-"));
  const dir = path.join(root, "state");
  try {
    const first = await loadOrCreatePairingState(dir);
    assert.equal(await first.claimPairing(), true);
    assert.equal(await first.claimPairing(), false);
    const second = await loadOrCreatePairingState(dir);
    assert.equal(second.token, first.token);
    assert.equal(await second.claimPairing(), false);
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    const file = path.join(dir, "pairing.json");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.token, first.token);
    assert.equal(persisted.paired, true);
    assert.equal(resolvePairingDir({ ALIBABA_MCP_STATE_DIR: dir }), dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy pairing state without a claim flag stays claimed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alibaba-pairing-legacy-"));
  const dir = path.join(root, "state");
  try {
    const created = await loadOrCreatePairingState(dir);
    const file = path.join(dir, "pairing.json");
    await writeFile(file, `${JSON.stringify({ version: 1, token: created.token })}\n`);
    await chmod(file, 0o600);
    const loaded = await loadOrCreatePairingState(dir);
    assert.equal(loaded.token, created.token);
    assert.equal(await loaded.claimPairing(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing state rejects permissive directories and symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "alibaba-pairing-bad-"));
  try {
    const loose = path.join(root, "loose");
    await loadOrCreatePairingState(loose);
    await chmod(loose, 0o755);
    await assert.rejects(loadOrCreatePairingState(loose), /0700/);
    const link = path.join(root, "link");
    await symlink(loose, link);
    await assert.rejects(loadOrCreatePairingState(link), /private directory/);
    assert.throws(() => resolvePairingDir({ ALIBABA_MCP_STATE_DIR: "relative" }), /absolute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
