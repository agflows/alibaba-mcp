import { spawnSync } from "node:child_process";
import { build, context } from "esbuild";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");
const watch = process.argv.includes("--watch");
const allowedPermissions = new Set(["alarms", "storage"]);
const forbiddenFields = [
  "optional_permissions",
  "optional_host_permissions",
  "externally_connectable",
  "devtools_page",
  "chrome_url_overrides",
];

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "server"), { recursive: true });
await mkdir(resolve(out, "extension"), { recursive: true });
await mkdir(resolve(out, "installer"), { recursive: true });
await mkdir(resolve(out, "proxy"), { recursive: true });

const jobs = [
  {
    entryPoints: [resolve(root, "src/server/index.ts")],
    outfile: resolve(out, "server/index.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    packages: "external",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entryPoints: [resolve(root, "src/proxy/server.ts")],
    outfile: resolve(out, "proxy/server.cjs"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entryPoints: [resolve(root, "src/installer/index.ts")],
    outfile: resolve(out, "installer/index.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    packages: "external",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entryPoints: [resolve(root, "src/extension/background.ts")],
    outfile: resolve(out, "extension/background.js"),
    bundle: true,
    platform: "browser",
    target: "chrome116",
    format: "esm",
    sourcemap: true,
  },
  {
    entryPoints: [resolve(root, "src/extension/content.ts")],
    outfile: resolve(out, "extension/content.js"),
    bundle: true,
    platform: "browser",
    target: "chrome116",
    format: "iife",
    sourcemap: true,
  },
  {
    entryPoints: [resolve(root, "src/extension/page-api.ts")],
    outfile: resolve(out, "extension/page-api.js"),
    bundle: true,
    platform: "browser",
    target: "chrome116",
    format: "iife",
    sourcemap: true,
  },
  {
    entryPoints: [resolve(root, "src/extension/popup.ts")],
    outfile: resolve(out, "extension/popup.js"),
    bundle: true,
    platform: "browser",
    target: "chrome116",
    format: "esm",
    sourcemap: true,
  },
];

for (const name of ["manifest.json", "popup.html", "popup.css"]) {
  await cp(resolve(root, "src/extension", name), resolve(out, "extension", name));
}
await cp(resolve(root, "src/extension/icons"), resolve(out, "extension/icons"), { recursive: true });
await stampExtension();

if (watch) {
  const contexts = await Promise.all(jobs.map((job) => context(job)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("Watching alibaba-mcp sources…");
  await new Promise(() => {});
} else {
  await Promise.all(jobs.map((job) => build(job)));
  await chmod(resolve(out, "server/index.js"), 0o755);
  await chmod(resolve(out, "installer/index.js"), 0o755);
  await chmod(resolve(out, "proxy/server.cjs"), 0o755);
  await assertServerBundle();
  console.log("Built dist/server and dist/extension");
}

async function stampExtension() {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const manifestPath = resolve(out, "extension/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = pkg.version;
  assertManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertManifest(manifest) {
  const permissions = manifest.permissions ?? [];
  if (permissions.length !== allowedPermissions.size || permissions.some((item) => !allowedPermissions.has(item))) {
    throw new Error(`Refusing to package extension permissions: ${permissions.join(", ") || "(none)"}`);
  }
  const hosts = [
    "https://*.aliyuncs.com/*",
    "https://*.clouddisk.alibaba.com/*",
    "https://alibaba-mcp-proxy.leogruetzner.com/*",
    "https://clouddisk.alibaba.com/*",
    "https://message.alibaba.com/*",
  ];
  if (JSON.stringify([...(manifest.host_permissions ?? [])].sort()) !== JSON.stringify([...hosts].sort())) {
    throw new Error("Refusing to package unexpected host permissions.");
  }
  for (const field of forbiddenFields) {
    if (field in manifest) throw new Error(`Manifest must not include ${field}.`);
  }
  const policy = manifest.content_security_policy?.extension_pages ?? "";
  const connect = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  const connectSources = connect?.slice("connect-src ".length).split(/\s+/).sort() ?? [];
  const allowedConnect = [
    "https://*.aliyuncs.com",
    "https://*.clouddisk.alibaba.com",
    "https://clouddisk.alibaba.com",
    "wss://alibaba-mcp-proxy.leogruetzner.com",
  ].sort();
  const wssHosts = policy.match(/wss:\/\/[^\s;]+/g) ?? [];
  if (
    JSON.stringify(connectSources) !== JSON.stringify(allowedConnect) ||
    wssHosts.length !== 1 ||
    wssHosts[0] !== "wss://alibaba-mcp-proxy.leogruetzner.com" ||
    /unsafe-eval|unsafe-inline|\bhttp:|message\.alibaba\.com/.test(policy)
  ) {
    throw new Error("Extension CSP connect-src must list only the private relay and the attachment hosts.");
  }
  if (manifest.background?.service_worker !== "background.js" || manifest.background?.type !== "module") {
    throw new Error("Background must be an MV3 module service worker.");
  }
  const scripts = manifest.content_scripts ?? [];
  const mainWorld = scripts.find((script) => script.world === "MAIN");
  const isolated = scripts.find((script) => script.js?.includes("content.js"));
  if (
    scripts.length !== 2 ||
    mainWorld?.js?.join(",") !== "page-api.js" ||
    mainWorld.run_at !== "document_start" ||
    mainWorld.all_frames === true ||
    isolated?.js?.join(",") !== "content.js" ||
    isolated.world
  ) {
    throw new Error("The messenger page script must run in the top-frame page world, and the content script must stay isolated.");
  }
  if (manifest.update_url !== "https://raw.githubusercontent.com/agflows/alibaba-mcp/main/updates.xml") {
    throw new Error("Extension update_url must point at the GitHub updates manifest.");
  }
}

async function assertServerBundle() {
  const file = resolve(out, "server/index.js");
  const source = await readFile(file, "utf8");
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Server entry is missing its shebang.");
  }
  if (source.slice(1).includes("#!/usr/bin/env node")) {
    throw new Error("Server entry contains a second shebang.");
  }
  if (source.includes('Dynamic require of "')) {
    throw new Error("Server bundle contains an unsupported dynamic require shim.");
  }
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) {
    throw new Error(checked.stderr || "Server bundle failed syntax check.");
  }
}
