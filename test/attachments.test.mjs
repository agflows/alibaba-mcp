import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import {
  AttachmentCache,
  ExtensionBridge,
  authProof,
  ageFile,
  createAlibabaMcpServer,
  createPairingToken,
  downloadToCache,
  resolveCacheDir,
} from "../.test-build/app.mjs";
import {
  attachmentFetchUrl,
  attachmentRedirectTarget,
  decodeChunkFrame,
  encodeChunkFrame,
  publicAttachmentList,
  redactSensitive,
  safeAgentError,
  sanitizeFileName,
} from "../.test-build/attachments.mjs";
import { streamAttachment } from "../.test-build/download.mjs";

const extensionId = "d".repeat(32);
const attachmentId = "att_demo_abcd1234";
const signedUrl = "https://clouddisk.alibaba.com/files/quote.pdf?signature=topsecret&OSSAccessKeyId=KEY";
const ossUrl =
  "https://us-icbuim-file.oss-us-east-1.aliyuncs.com/quote%2Ffile.pdf?OSSAccessKeyId=KEY&Signature=abc%2Bdef&security-token=sts-token";

function bridgeOptions(token) {
  return {
    port: 0,
    token,
    extensionIds: [extensionId],
    requestTimeoutMs: 2_000,
    heartbeatMs: 60_000,
    staleAfterMs: 60_000,
  };
}

function connectClient(bridge, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/`, { origin: `chrome-extension://${extensionId}` });
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(String(data));
    if (message.type === "auth-challenge") socket.send(JSON.stringify({ type: "auth-proof", proof: authProof(token, message.challenge) }));
    if (message.type === "auth-ok") socket.emit("authenticated");
  });
  return socket;
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket open")), 2_000);
    socket.once("authenticated", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket message")), 2_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
  });
}

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function responseAt(url, body, init = {}) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

test("attachment addresses stay on the clouddisk allowlist", () => {
  assert.equal(attachmentFetchUrl(signedUrl)?.hostname, "clouddisk.alibaba.com");
  assert.equal(attachmentFetchUrl("https://cdn.clouddisk.alibaba.com/a")?.hostname, "cdn.clouddisk.alibaba.com");
  assert.equal(attachmentFetchUrl("https://clouddisk.alibaba.com:443/a")?.hostname, "clouddisk.alibaba.com");
  assert.equal(attachmentFetchUrl(ossUrl), null);
  for (const blocked of [
    "http://clouddisk.alibaba.com/a",
    "https://user:pass@clouddisk.alibaba.com/a",
    "https://clouddisk.alibaba.com:8443/a",
    "https://clouddisk.alibaba.com.evil.com/a",
    "https://notclouddisk.alibaba.com/a",
    "https://evil.com/clouddisk.alibaba.com",
    "https://message.alibaba.com/a",
    "https://bucket.oss-us-east-1.aliyuncs.com/a",
    "/relative",
  ]) {
    assert.equal(attachmentFetchUrl(blocked), null, blocked);
  }
});

test("redirects may follow only clouddisk or an oss virtual host", () => {
  assert.equal(attachmentRedirectTarget(ossUrl), ossUrl);
  assert.equal(
    attachmentRedirectTarget("https://example-bucket.oss.aliyuncs.com/a.pdf"),
    "https://example-bucket.oss.aliyuncs.com/a.pdf",
  );
  assert.equal(
    attachmentRedirectTarget("https://example-bucket.oss-cn-hangzhou.aliyuncs.com:443/a.pdf"),
    "https://example-bucket.oss-cn-hangzhou.aliyuncs.com:443/a.pdf",
  );
  assert.equal(attachmentRedirectTarget(" https://clouddisk.alibaba.com/files/ok.bin "), "https://clouddisk.alibaba.com/files/ok.bin");
  for (const blocked of [
    "http://us-icbuim-file.oss-us-east-1.aliyuncs.com/a.pdf",
    "https://user:pass@us-icbuim-file.oss-us-east-1.aliyuncs.com/a.pdf",
    "https://us-icbuim-file.oss-us-east-1.aliyuncs.com:8443/a.pdf",
    "https://oss-us-east-1.aliyuncs.com/us-icbuim-file/a.pdf?Signature=sekrit",
    "https://ram.aliyuncs.com/a?Signature=sekrit",
    "https://example-bucket.ecs.aliyuncs.com/a.pdf",
    "https://us-icbuim-file.oss-us-east-1.aliyuncs.com.evil.com/a.pdf",
    "https://a.b.oss-us-east-1.aliyuncs.com/a.pdf",
    "https://ab.oss-us-east-1.aliyuncs.com/a.pdf",
    "https://evil.example/a",
    "/relative",
  ]) {
    assert.equal(attachmentRedirectTarget(blocked), null, blocked);
  }
});

test("public attachment results drop remote addresses and unsafe names", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName(".."), "attachment");
  assert.equal(sanitizeFileName(".hidden\u0000.pdf"), "hidden.pdf");
  const listed = publicAttachmentList({
    attachments: [
      {
        id: attachmentId,
        messageId: "m1",
        name: "../quote.pdf",
        sizeBytes: 12,
        type: "application/pdf",
        downloadUrl: signedUrl,
        url: signedUrl,
      },
      { id: "not-an-id", name: "skip", downloadUrl: signedUrl },
    ],
  });
  assert.deepEqual(listed, {
    attachments: [
      {
        id: attachmentId,
        messageId: "m1",
        name: "quote.pdf",
        byteSize: 12,
        contentType: "application/pdf",
      },
    ],
  });
  assert.equal(JSON.stringify(listed).includes("topsecret"), false);
  assert.equal(JSON.stringify(listed).includes("clouddisk"), false);
});

test("agent errors keep the inbox instruction and drop signed addresses", () => {
  const inbox = "Open https://message.alibaba.com/ in a logged-in Chrome tab.";
  assert.equal(redactSensitive(inbox), inbox);
  assert.equal(safeAgentError(inbox), inbox);
  assert.equal(safeAgentError("Chat access is disabled."), "Chat access is disabled.");
  assert.equal(
    safeAgentError(`fetch failed ${signedUrl}`),
    "Attachment download failed.",
  );
  assert.equal(safeAgentError(`fetch failed ${signedUrl}`).includes("topsecret"), false);
  assert.equal(safeAgentError(`fetch failed ${ossUrl}`), "Attachment download failed.");
  assert.equal(safeAgentError("moved to us-icbuim-file.oss-us-east-1.aliyuncs.com"), "Attachment download failed.");
  assert.equal(safeAgentError("OSSAccessKeyId=KEY"), "Attachment download failed.");
  assert.equal(safeAgentError("https://message.alibaba.com/a?token=1"), "Attachment download failed.");
  assert.equal(safeAgentError(`fetch failed ${ossUrl}`).includes("sts-token"), false);
  assert.equal(safeAgentError(`fetch failed ${ossUrl}`).includes("aliyuncs"), false);
});

test("binary chunk frames round-trip", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const payload = new Uint8Array([9, 8, 7]);
  const decoded = decodeChunkFrame(encodeChunkFrame(id, 256, payload));
  assert.equal(decoded?.id, id);
  assert.equal(decoded?.offset, 256);
  assert.deepEqual(decoded?.data, payload);
  assert.equal(decodeChunkFrame(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
  assert.throws(() => encodeChunkFrame(id, 0, new Uint8Array()));
});

test("streaming fetch omits credentials and never emits the address", async () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const seen = [];
  const sent = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174000",
    signal: new AbortController().signal,
    prepare: async () => ({
      downloadUrl: signedUrl,
      name: "../reports/quote.pdf",
      sizeBytes: payload.byteLength,
      type: "application/pdf",
      url: signedUrl,
    }),
    fetchImpl: async (input, init) => {
      seen.push({ input, init });
      return responseAt(signedUrl, payload, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(payload.byteLength) },
      });
    },
    sendJson: (message) => sent.push(JSON.stringify(message)),
    sendBinary: (frame) => sent.push(Buffer.from(frame).toString("hex")),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, signedUrl);
  assert.equal(seen[0].init.credentials, "omit");
  assert.equal(seen[0].init.cache, "no-store");
  assert.equal(seen[0].init.redirect, "follow");
  assert.equal(seen[0].init.referrerPolicy, "no-referrer");
  const wire = sent.join("\n");
  assert.equal(wire.includes("clouddisk"), false);
  assert.equal(wire.includes("topsecret"), false);
  assert.equal(wire.includes("KEY"), false);
  assert.match(wire, /download-start/);
  assert.match(wire, /quote\.pdf/);
  assert.match(wire, /download-end/);
});

test("the final response address must stay on the allowlist and is never echoed", async () => {
  const ossCalls = [];
  const ossSent = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174006",
    signal: new AbortController().signal,
    prepare: async () => ({ downloadUrl: "https://clouddisk.alibaba.com/start?signature=topsecret", name: "quote.pdf", sizeBytes: 4 }),
    fetchImpl: async (input, init) => {
      ossCalls.push({ input, init });
      return responseAt(ossUrl, new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "4" },
      });
    },
    sendJson: (message) => ossSent.push(message),
    sendBinary: () => {},
  });
  assert.equal(ossCalls.length, 1);
  assert.equal(ossCalls[0].input, "https://clouddisk.alibaba.com/start?signature=topsecret");
  assert.equal(ossCalls[0].init.credentials, "omit");
  assert.equal(ossCalls[0].init.redirect, "follow");
  assert.equal(ossCalls[0].init.referrerPolicy, "no-referrer");
  assert.equal(ossSent.at(-1).type, "download-end");
  const ossWire = JSON.stringify(ossSent);
  assert.equal(ossWire.includes("aliyuncs"), false);
  assert.equal(ossWire.includes("abc%2Bdef"), false);
  assert.equal(ossWire.includes("sts-token"), false);
  assert.equal(ossWire.includes("topsecret"), false);
  assert.equal(ossWire.includes("KEY"), false);

  const denied = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174002",
    signal: new AbortController().signal,
    prepare: async () => ({ downloadUrl: signedUrl, name: "a.bin" }),
    fetchImpl: async () => responseAt("https://evil.example/x?signature=sekrit", new Uint8Array([1, 2, 3]), { status: 200 }),
    sendJson: (message) => denied.push(message),
    sendBinary: () => {},
  });
  assert.equal(denied.at(-1).error, "Attachment host is not allowed.");
  assert.equal(denied.some((message) => message.type === "download-start"), false);
  assert.equal(JSON.stringify(denied).includes("sekrit"), false);
  assert.equal(JSON.stringify(denied).includes("evil.example"), false);
  assert.equal(JSON.stringify(denied).includes("clouddisk"), false);

  const opaque = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174009",
    signal: new AbortController().signal,
    prepare: async () => ({ downloadUrl: signedUrl, name: "a.bin" }),
    fetchImpl: async () => {
      const response = responseAt("", null, { status: 200 });
      Object.defineProperty(response, "type", { configurable: true, value: "opaqueredirect" });
      return response;
    },
    sendJson: (message) => opaque.push(message),
    sendBinary: () => {},
  });
  assert.equal(opaque.at(-1).error, "Attachment host is not allowed.");
  assert.equal(opaque.some((message) => message.type === "download-start"), false);

  let fetchedOss = false;
  const rejectedOss = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174007",
    signal: new AbortController().signal,
    prepare: async () => ({ downloadUrl: ossUrl, name: "quote.pdf" }),
    fetchImpl: async () => {
      fetchedOss = true;
      return responseAt(ossUrl, new Uint8Array([1]), { status: 200 });
    },
    sendJson: (message) => rejectedOss.push(message),
    sendBinary: () => {},
  });
  assert.equal(fetchedOss, false);
  assert.equal(rejectedOss.at(-1).error, "Attachment host is not allowed.");

  const foreign = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174008",
    signal: new AbortController().signal,
    prepare: async () => ({ downloadUrl: "https://clouddisk.alibaba.com/start", name: "a.bin" }),
    fetchImpl: async () =>
      responseAt("https://oss-us-east-1.aliyuncs.com/us-icbuim-file/a.pdf?Signature=sekrit", new Uint8Array([1]), { status: 200 }),
    sendJson: (message) => foreign.push(message),
    sendBinary: () => {},
  });
  assert.equal(foreign.at(-1).error, "Attachment host is not allowed.");
  assert.equal(foreign.some((message) => message.type === "download-start"), false);
  assert.equal(JSON.stringify(foreign).includes("sekrit"), false);
  assert.equal(JSON.stringify(foreign).includes("aliyuncs"), false);
});

test("declared and streamed sizes are bounded, and cancel does not fetch", async () => {
  const tooBig = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174003",
    signal: new AbortController().signal,
    maxBytes: 4,
    prepare: async () => ({ downloadUrl: "https://cdn.clouddisk.alibaba.com/a", name: "a.bin" }),
    fetchImpl: async () =>
      responseAt("https://cdn.clouddisk.alibaba.com/a", new Uint8Array([1]), {
        status: 200,
        headers: { "content-length": "9" },
      }),
    sendJson: (message) => tooBig.push(message),
    sendBinary: () => {},
  });
  assert.equal(tooBig.at(-1).error, "Attachment exceeds the size limit.");
  assert.equal(tooBig.some((message) => message.type === "download-start"), false);

  const streamed = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174004",
    signal: new AbortController().signal,
    maxBytes: 4,
    prepare: async () => ({ downloadUrl: "https://clouddisk.alibaba.com/a", name: "a.bin" }),
    fetchImpl: async () =>
      responseAt(
        "https://clouddisk.alibaba.com/a",
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    sendJson: (message) => streamed.push(message),
    sendBinary: () => {},
  });
  assert.equal(streamed.at(-1).error, "Attachment exceeds the size limit.");
  assert.equal(JSON.stringify(streamed).includes("clouddisk"), false);

  let prepared = false;
  const controller = new AbortController();
  controller.abort();
  const cancelled = [];
  await streamAttachment({
    id: "123e4567-e89b-12d3-a456-426614174005",
    signal: controller.signal,
    prepare: async () => {
      prepared = true;
      return { downloadUrl: signedUrl, name: "a.bin" };
    },
    sendJson: (message) => cancelled.push(message),
    sendBinary: () => {},
  });
  assert.equal(prepared, false);
  assert.equal(cancelled.at(-1).error, "Attachment download was cancelled.");
});

test("cache files are private, unique, expiring, and never followed", async () => {
  assert.throws(() => resolveCacheDir("relative/cache"), /absolute path/);
  const directory = await tempDir("alibaba-mcp-cache-");
  try {
    const cache = await AttachmentCache.open(directory);
    const directoryStat = await lstat(directory);
    assert.equal(directoryStat.isSymbolicLink(), false);
    assert.equal(directoryStat.mode & 0o077, 0);

    const outside = path.join(directory, "..", `keep-${path.basename(directory)}.txt`);
    await writeFile(outside, "keep");
    await symlink(outside, path.join(directory, "link"));
    await writeFile(path.join(directory, "nested-dir-marker"), "x");
    const nested = path.join(directory, "subdir");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested);

    const first = await cache.begin("../../etc/passwd", 10);
    await first.write(new TextEncoder().encode("hello"));
    const finished = await first.finish();
    assert.equal(finished.name, "passwd");
    assert.equal(finished.path.startsWith(`${directory}${path.sep}`), true);
    assert.equal(finished.path.includes(`${path.sep}..${path.sep}`), false);
    const fileStat = await lstat(finished.path);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(fileStat.mode & 0o111, 0);
    assert.equal(await readFile(finished.path, "utf8"), "hello");
    assert.equal(finished.sha256, createHash("sha256").update("hello").digest("hex"));

    const second = await cache.begin("passwd", 10);
    await second.write(new Uint8Array([1]));
    const other = await second.finish();
    assert.notEqual(other.path, finished.path);
    await second.abort();
    await assert.rejects(lstat(other.path));

    const partial = await cache.begin("partial.txt", 10);
    await partial.write(new Uint8Array([1, 2]));
    await partial.abort();
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".partial")), false);

    await ageFile(finished.path, Date.now() - 25 * 60 * 60 * 1000);
    assert.equal(await cache.sweep(), 1);
    await assert.rejects(lstat(finished.path));

    const fresh = await cache.begin("fresh.txt", 10);
    await fresh.write(new Uint8Array([3]));
    const kept = await fresh.finish();
    const stalePartial = await cache.begin("stale.txt", 10);
    const partialName = (await readdir(directory)).find((name) => name.endsWith(".partial"));
    await ageFile(path.join(directory, partialName), Date.now() - 16 * 60 * 1000);
    assert.equal(await cache.sweep(), 1);
    assert.equal(await readFile(kept.path, "utf8"), "\u0003");
    await stalePartial.abort();

    const removed = await cache.clear();
    assert.equal(removed >= 1, true);
    assert.equal(await readFile(outside, "utf8"), "keep");
    assert.equal((await lstat(path.join(directory, "link"))).isSymbolicLink(), true);
    assert.equal((await lstat(nested)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a signed extension error is removed before it reaches the agent", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token));
  const directory = await tempDir("alibaba-mcp-redact-");
  const socket = connectClient(bridge, token);
  try {
    await bridge.ready;
    await opened(socket);
    const cache = await AttachmentCache.open(directory);
    const pending = downloadToCache(bridge, cache, { conversationId: "conv-1", attachmentId }, undefined, 100);
    const incoming = await nextMessage(socket);
    const request = JSON.parse(String(incoming.data));
    socket.send(JSON.stringify({ id: request.id, type: "download-error", error: `fetch failed ${signedUrl}` }));
    await assert.rejects(pending, (error) => {
      assert.match(error.message, /Attachment download failed/);
      assert.equal(error.message.includes("topsecret"), false);
      assert.equal(error.message.includes("clouddisk"), false);
      assert.equal(error.message.includes("KEY"), false);
      return true;
    });
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".partial")), false);
  } finally {
    socket.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel removes the private partial file", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token));
  const directory = await tempDir("alibaba-mcp-cancel-");
  const socket = connectClient(bridge, token);
  const controller = new AbortController();
  try {
    await bridge.ready;
    await opened(socket);
    const cache = await AttachmentCache.open(directory);
    const pending = downloadToCache(bridge, cache, { conversationId: "conv-1", attachmentId }, controller.signal);
    const incoming = await nextMessage(socket);
    const request = JSON.parse(String(incoming.data));
    socket.send(JSON.stringify({ id: request.id, type: "download-start", name: "note.txt", byteSize: 4 }));
    const started = Date.now();
    while (!(await readdir(directory)).some((name) => name.endsWith(".partial"))) {
      if (Date.now() - started > 1_000) throw new Error("partial file was not created");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".partial") || name.includes("note.txt")), false);
  } finally {
    socket.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mcp list and download return a local file and no remote address", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token));
  const directory = await tempDir("alibaba-mcp-download-");
  const payload = new TextEncoder().encode("quote");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "alibaba-mcp-test", version: "0.0.0" });
  const socket = connectClient(bridge, token);
  let server;
  try {
    await bridge.ready;
    await opened(socket);
    server = createAlibabaMcpServer(bridge, { cacheDir: directory });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(String(data));
      if (message.method === "list_attachments") {
        socket.send(
          JSON.stringify({
            id: message.id,
            ok: true,
            result: [
              {
                id: attachmentId,
                messageId: "m1",
                name: "quote.pdf",
                sizeBytes: payload.byteLength,
                type: "application/pdf",
                downloadUrl: signedUrl,
              },
            ],
          }),
        );
        return;
      }
      if (message.method !== "download_attachment") return;
      void streamAttachment({
        id: message.id,
        signal: new AbortController().signal,
        prepare: async () => ({
          downloadUrl: signedUrl,
          name: "../quote.pdf",
          sizeBytes: payload.byteLength,
          type: "application/pdf",
        }),
        fetchImpl: async (_input, init) => {
          assert.equal(init.credentials, "omit");
          assert.equal(init.redirect, "follow");
          assert.equal(init.referrerPolicy, "no-referrer");
          return responseAt(ossUrl, payload, {
            status: 200,
            headers: { "content-type": "application/pdf", "content-length": String(payload.byteLength) },
          });
        },
        sendJson: (body) => socket.send(JSON.stringify(body)),
        sendBinary: (frame) => socket.send(frame),
      });
    });

    const listed = await client.callTool({
      name: "alibaba_list_attachments",
      arguments: { conversationId: "conv-1", limit: 10 },
    });
    const listedText = listed.content?.find((item) => item.type === "text")?.text ?? "";
    assert.notEqual(listed.isError, true);
    assert.match(listedText, new RegExp(attachmentId));
    assert.equal(listedText.includes(signedUrl), false);
    assert.equal(listedText.includes("topsecret"), false);
    assert.equal(listedText.includes("clouddisk"), false);

    const downloaded = await client.callTool({
      name: "alibaba_download_attachment",
      arguments: { conversationId: "conv-1", attachmentId },
    });
    const downloadedText = downloaded.content?.find((item) => item.type === "text")?.text ?? "";
    assert.notEqual(downloaded.isError, true);
    assert.equal(downloadedText.includes("http"), false);
    assert.equal(downloadedText.includes("topsecret"), false);
    assert.equal(downloadedText.includes("clouddisk"), false);
    assert.equal(downloadedText.includes("aliyuncs"), false);
    assert.equal(downloadedText.includes("sts-token"), false);
    const saved = JSON.parse(downloadedText);
    assert.equal(saved.name, "quote.pdf");
    assert.equal(saved.byteSize, payload.byteLength);
    assert.equal(saved.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.equal(saved.path.startsWith(`${directory}${path.sep}`), true);
    assert.equal((await lstat(saved.path)).mode & 0o777, 0o600);
    assert.equal(await readFile(saved.path, "utf8"), "quote");

    const cleared = await client.callTool({ name: "alibaba_clear_cache", arguments: {} });
    assert.notEqual(cleared.isError, true);
    await assert.rejects(lstat(saved.path));
  } finally {
    socket.close();
    await client.close().catch(() => {});
    await server?.close().catch(() => {});
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
