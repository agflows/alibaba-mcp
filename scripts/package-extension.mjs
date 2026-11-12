import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const extensionDir = resolve(root, "dist", "extension");
const output = resolve(root, "dist", "alibaba-mcp-extension.zip");
const entries = {};

for (const file of await filesUnder(extensionDir)) {
  if (file.endsWith(".map")) continue;
  const name = `extension/${relative(extensionDir, file).split(sep).join("/")}`;
  entries[name] = new Uint8Array(await readFile(file));
}

await writeFile(output, zipSync(entries, { level: 9 }), { mode: 0o600 });
console.log(`Wrote ${output}`);

async function filesUnder(directory) {
  const files = [];
  const items = await readdir(directory, { withFileTypes: true });
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) files.push(...await filesUnder(path));
    else if (item.isFile()) files.push(path);
    else throw new Error(`Refusing to package non-file entry: ${path}`);
  }
  return files;
}
