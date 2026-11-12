import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const cli = path.resolve(".test-build/installer.mjs");

test("companion setup installs, reports, backs up, and uninstalls without secrets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "alibaba-installer-"));
  const config = path.join(dir, "mcp.json");
  try {
    await writeFile(config, '{"other":true,"mcpServers":{"existing":{"command":"x"}}}\n');
    await run("install", config);
    const installed = JSON.parse(await readFile(config, "utf8"));
    assert.equal(installed.other, true);
    assert.deepEqual(installed.mcpServers.existing, { command: "x" });
    assert.equal(installed.mcpServers.alibaba.command, process.execPath);
    assert.equal(Array.isArray(installed.mcpServers.alibaba.args), true);
    assert.equal("env" in installed.mcpServers.alibaba, false);
    assert.doesNotMatch(JSON.stringify(installed), /token|secret/i);

    const status = JSON.parse((await run("status", config)).stdout);
    assert.equal(status.installed, true);

    const removed = await run("uninstall", config);
    assert.match(removed.stdout, /Backup:/);
    const uninstalled = JSON.parse(await readFile(config, "utf8"));
    assert.equal("alibaba" in uninstalled.mcpServers, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function run(command, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command], {
      env: { ...process.env, ALIBABA_MCP_CURSOR_CONFIG: config },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
