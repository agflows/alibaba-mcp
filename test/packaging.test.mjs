import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

test("package stays private and local checks do not call Alibaba", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.prepare, "node scripts/build.mjs");
  assert.equal(pkg.scripts.pretest, "node scripts/build-test.mjs");
  assert.equal(pkg.scripts.test.includes("live-test"), false);
  assert.equal(pkg.scripts.check.includes("live-test"), false);
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("SECURITY.md"));
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"] !== undefined, true);
  assert.equal(existsSync(resolve(root, "scripts/live-test.mjs")), false);
  assert.equal(existsSync(resolve(root, "scripts/package-extension.mjs")), true);
  assert.equal(pkg.scripts["package:extension"], "npm run build && node scripts/package-extension.mjs");
  const build = read("scripts/build.mjs");
  assert.match(build, /packages:\s*"external"/);
  assert.match(build, /Dynamic require/);
});

test("manifest is pinned, minimal, and localhost only", () => {
  const manifest = JSON.parse(read("src/extension/manifest.json"));
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "storage"]);
  assert.deepEqual([...manifest.host_permissions].sort(), [
    "https://*.aliyuncs.com/*",
    "https://*.clouddisk.alibaba.com/*",
    "https://clouddisk.alibaba.com/*",
    "https://message.alibaba.com/*",
  ]);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.background.type, "module");
  assert.equal("externally_connectable" in manifest, false);
  const policy = manifest.content_security_policy.extension_pages;
  const connect = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  assert.deepEqual(connect.slice("connect-src ".length).split(/\s+/).sort(), [
    "https://*.aliyuncs.com",
    "https://*.clouddisk.alibaba.com",
    "https://clouddisk.alibaba.com",
    "ws://127.0.0.1:17873",
  ]);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval|unsafe-inline|\bhttp:|\bwss:|message\.alibaba\.com/);
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 15];
  assert.equal(id, "ligjbkljdnlcjpfglgjmflggigiomlic");
  assert.equal(JSON.parse(read("package.json")).version, manifest.version);
});

test("local bridge code does not ask for cookies or a public bind", () => {
  const files = [
    "src/server/index.ts",
    "src/server/bridge.ts",
    "src/server/auth.ts",
    "src/server/app.ts",
    "src/extension/background.ts",
    "src/extension/popup.ts",
    "src/extension/download.ts",
    "src/server/cache.ts",
    "src/server/transfer.ts",
    "src/shared/attachments.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /cookie/i, file);
    assert.doesNotMatch(source, /0\.0\.0\.0/, file);
    assert.doesNotMatch(source, /ALLOW_NO_ORIGIN/, file);
    assert.equal(source.includes("console.log"), false, file);
  }
  const background = read("src/extension/background.ts");
  assert.match(background, /chrome\.alarms/);
  assert.match(background, /chrome\.runtime\.onStartup/);
  assert.match(background, /isExtensionUiSender/);
  assert.match(background, /BRIDGE_URL/);
  const bridge = read("src/server/bridge.ts");
  assert.match(bridge, /tokensMatch/);
  assert.match(bridge, /isLoopbackAddress/);
  assert.match(bridge, /BRIDGE_HOST/);
  const protocol = read("src/shared/protocol.ts");
  assert.match(protocol, /127\.0\.0\.1/);
  assert.match(protocol, /BRIDGE_PORT = 17873/);
  const cache = read("src/server/cache.ts");
  assert.doesNotMatch(cache, /child_process|execFile|spawn\(/);
  assert.match(cache, /0o700/);
  assert.match(cache, /0o600/);
});
