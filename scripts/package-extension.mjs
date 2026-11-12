import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { createCrx } from "./crx.mjs";

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, "dist", "extension");
const updateUrl = "https://raw.githubusercontent.com/agflows/alibaba-mcp/main/updates.xml";
const keyPath = process.env.ALIBABA_MCP_EXTENSION_KEY
  ? resolve(process.env.ALIBABA_MCP_EXTENSION_KEY)
  : resolve(root, "keys", "extension.pem");

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
const updates = await readFile(resolve(root, "updates.xml"), "utf8");
const privateKey = await readFile(keyPath);
const archive = Buffer.from(zipSync(await extensionEntries(extensionDir), { level: 9 }));
const packed = createCrx(archive, privateKey);
const codebase = `https://github.com/agflows/alibaba-mcp/releases/download/v${pkg.version}/alibaba-mcp.crx`;

if (manifest.version !== pkg.version) throw new Error("Built manifest version does not match package.json.");
if (manifest.update_url !== updateUrl) throw new Error("Built manifest update_url is not the GitHub updates manifest.");
if (packed.publicKey !== manifest.key) throw new Error("Signing key does not match the public key pinned in the manifest.");
if (!updates.includes(`appid='${packed.id}'`)) throw new Error("updates.xml app id does not match the signing key.");
if (!updates.includes(`version='${pkg.version}'`)) throw new Error("updates.xml version does not match package.json.");
if (!updates.includes(`codebase='${codebase}'`)) throw new Error("updates.xml does not point at this version's GitHub CRX.");

await writeFile(resolve(root, "dist", "alibaba-mcp.crx"), packed.crx, { mode: 0o644 });
await writeFile(resolve(root, "dist", "alibaba-mcp.zip"), archive, { mode: 0o644 });
console.log(`Wrote dist/alibaba-mcp.crx for ${packed.id}`);
console.log("Wrote dist/alibaba-mcp.zip");

async function extensionEntries(directory) {
  const entries = {};
  for (const file of await filesUnder(directory)) {
    if (file.endsWith(".map")) continue;
    const name = relative(directory, file).split(sep).join("/");
    if (name.split("/").some((part) => part === ".." || part.startsWith("."))) {
      throw new Error(`Refusing to package ${name}`);
    }
    entries[name] = new Uint8Array(await readFile(file));
  }
  if (!entries["manifest.json"]) throw new Error("Extension package is missing manifest.json.");
  return entries;
}

async function filesUnder(directory) {
  const files = [];
  const items = await readdir(directory, { withFileTypes: true });
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${path}`);
    if (item.isDirectory()) files.push(...await filesUnder(path));
    else if (item.isFile()) files.push(path);
    else throw new Error(`Refusing to package non-file entry: ${path}`);
  }
  return files;
}
