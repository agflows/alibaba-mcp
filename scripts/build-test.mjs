import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, ".test-build");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/extension/alibaba-adapter.ts")],
  outfile: resolve(out, "alibaba-adapter.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
});

await build({
  entryPoints: {
    app: resolve(root, "src/server/app.ts"),
    protocol: resolve(root, "src/shared/protocol.ts"),
    reconnect: resolve(root, "src/extension/reconnect.ts"),
    attachments: resolve(root, "src/shared/attachments.ts"),
    download: resolve(root, "src/extension/download.ts"),
    cache: resolve(root, "src/server/cache.ts"),
    installer: resolve(root, "src/installer/index.ts"),
  },
  outdir: out,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  outExtension: { ".js": ".mjs" },
});
