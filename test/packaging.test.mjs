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
  assert.ok(pkg.files.includes("PRIVACY.md"));
  assert.ok(pkg.files.includes("STORE_LISTING.md"));
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
    "https://alibaba-mcp-proxy.leogruetzner.com/*",
    "https://clouddisk.alibaba.com/*",
    "https://message.alibaba.com/*",
  ]);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.background.type, "module");
  assert.equal("externally_connectable" in manifest, false);
  assert.equal(manifest.icons[128], "icons/icon128.png");
  assert.equal(manifest.action.default_icon[32], "icons/icon32.png");
  for (const size of [16, 32, 48, 128]) assert.equal(existsSync(resolve(root, `src/extension/icons/icon${size}.png`)), true);
  const policy = manifest.content_security_policy.extension_pages;
  const connect = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  assert.deepEqual(connect.slice("connect-src ".length).split(/\s+/).sort(), [
    "https://*.aliyuncs.com",
    "https://*.clouddisk.alibaba.com",
    "https://clouddisk.alibaba.com",
    "wss://alibaba-mcp-proxy.leogruetzner.com",
  ]);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval|unsafe-inline|\bhttp:|message\.alibaba\.com/);
  assert.deepEqual(policy.match(/wss:\/\/[^\s;]+/g), ["wss://alibaba-mcp-proxy.leogruetzner.com"]);
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  const alphabet = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 15];
  const version = JSON.parse(read("package.json")).version;
  assert.equal(id, "ecklkjobkachpelpldagkdidgnjgpibf");
  assert.match(read("src/shared/protocol.ts"), new RegExp(`DEVELOPMENT_EXTENSION_ID = "${id}"`));
  assert.equal(manifest.update_url, "https://raw.githubusercontent.com/agflows/alibaba-mcp/main/updates.xml");
  assert.equal(manifest.homepage_url, "https://github.com/agflows/alibaba-mcp");
  const updates = read("updates.xml");
  assert.match(updates, new RegExp(`appid='${id}'`));
  assert.match(updates, new RegExp(`version='${version}'`));
  assert.match(updates, new RegExp(`releases/download/v${version}/alibaba-mcp\\.crx`));
  assert.equal(version, manifest.version);
});

test("local bridge code does not ask for cookies or a public bind", () => {
  const files = [
    "src/server/index.ts",
    "src/server/bridge.ts",
    "src/server/auth.ts",
    "src/server/app.ts",
    "src/server/pairing.ts",
    "src/extension/background.ts",
    "src/extension/popup.ts",
    "src/extension/download.ts",
    "src/server/cache.ts",
    "src/server/transfer.ts",
    "src/shared/attachments.ts",
    "src/proxy/server.ts",
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
  assert.match(background, /PROXY_URL/);
  assert.match(background, /proxy-hello/);
  assert.match(background, /copy-setup/);
  assert.match(background, /pairing-unavailable/);
  assert.match(background, /pairingUnavailable/);
  const bridge = read("src/server/bridge.ts");
  assert.match(bridge, /authProof/);
  assert.match(bridge, /proofsMatch/);
  assert.doesNotMatch(bridge, /searchParams\.set\("token"/);
  assert.match(bridge, /isLoopbackAddress/);
  assert.match(bridge, /BRIDGE_HOST/);
  const protocol = read("src/shared/protocol.ts");
  assert.match(protocol, /127\.0\.0\.1/);
  assert.match(protocol, /BRIDGE_PORT = 17873/);
  const popup = read("src/extension/popup.ts") + read("src/extension/popup.html");
  assert.doesNotMatch(popup, /rotate-token|pairing token|ALIBABA_MCP_TOKEN|\btoken\b/i);
  assert.match(popup, /Companion already paired/);
  assert.match(popup, /Copy instructions/);
  assert.match(popup, /copy-setup/);
  assert.match(popup, /alibaba-mcp-proxy\.leogruetzner\.com/);
  assert.match(popup, /pairingUnavailable/);
  assert.match(read("scripts/package-extension.mjs"), /endsWith\("\.map"\)/);
  const pairing = read("src/server/pairing.ts");
  assert.match(pairing, /0o700/);
  assert.match(pairing, /0o600/);
  const cache = read("src/server/cache.ts");
  assert.doesNotMatch(cache, /child_process|execFile|spawn\(/);
  assert.match(cache, /0o700/);
  assert.match(cache, /0o600/);
});
