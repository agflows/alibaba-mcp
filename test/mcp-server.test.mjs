import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { ExtensionBridge, authProof, createAlibabaMcpServer } from "../.test-build/app.mjs";
import { SEND_APPROVAL_INSTRUCTION, createPairingToken } from "../.test-build/protocol.mjs";

const extensionId = "c".repeat(32);

test("server instructions and send tool require explicit approval", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge({
    port: 0,
    token,
    extensionIds: [extensionId],
    requestTimeoutMs: 1000,
    heartbeatMs: 60_000,
    staleAfterMs: 60_000,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "alibaba-mcp-test", version: "0.0.0" });
  const cacheDir = await mkdtemp(join(tmpdir(), "alibaba-mcp-tools-"));
  let server;
  try {
    await bridge.ready;
    server = createAlibabaMcpServer(bridge, { cacheDir });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions.includes(SEND_APPROVAL_INSTRUCTION), true);
    assert.match(instructions, /cookies/i);
    assert.match(instructions, /none, read, or read\/write/);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "alibaba_clear_cache",
      "alibaba_download_attachment",
      "alibaba_get_conversation",
      "alibaba_list_attachments",
      "alibaba_list_conversations",
      "alibaba_send_message",
      "alibaba_status",
    ]);
    const download = listed.tools.find((tool) => tool.name === "alibaba_download_attachment");
    const clear = listed.tools.find((tool) => tool.name === "alibaba_clear_cache");
    assert.equal(download?.annotations?.openWorldHint, true);
    assert.equal(download?.annotations?.destructiveHint, false);
    assert.doesNotMatch(download?.description ?? "", /clouddisk|cookie/i);
    assert.equal(clear?.annotations?.destructiveHint, true);
    assert.equal(clear?.annotations?.openWorldHint, false);
    const cleared = await client.callTool({ name: "alibaba_clear_cache", arguments: {} });
    assert.notEqual(cleared.isError, true);
    assert.match(cleared.content?.find((item) => item.type === "text")?.text ?? "", /"removed": 0/);
    const send = listed.tools.find((tool) => tool.name === "alibaba_send_message");
    const status = listed.tools.find((tool) => tool.name === "alibaba_status");
    assert.equal(send?.description?.includes(SEND_APPROVAL_INSTRUCTION), true);
    assert.equal(send?.annotations?.readOnlyHint, false);
    assert.equal(send?.annotations?.destructiveHint, true);
    assert.equal(status?.annotations?.readOnlyHint, true);
    assert.equal(status?.annotations?.destructiveHint, false);

    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.some((prompt) => prompt.name === "approve-alibaba-send"), true);
    const prompt = await client.getPrompt({
      name: "approve-alibaba-send",
      arguments: { conversationId: "supplier-1", text: "Hello there" },
    });
    const rendered = JSON.stringify(prompt);
    assert.match(rendered, /Do not call alibaba_send_message/);
    assert.match(rendered, /Hello there/);

    const disconnected = await client.callTool({ name: "alibaba_status", arguments: {} });
    assert.equal(disconnected.isError, true);
    const disconnectedText = disconnected.content?.find((item) => item.type === "text")?.text ?? "";
    assert.match(disconnectedText, /not connected/i);
    assert.equal(disconnectedText.includes(token), false);

    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/`, {
      origin: `chrome-extension://${extensionId}`,
    });
    socket.on("error", () => {});
    const challengePending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("authentication challenge missing")), 2000);
      socket.once("message", (data) => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("extension socket did not open")), 2000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
    });
    const challenge = await challengePending;
    const authenticated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("authentication failed")), 2000);
      socket.once("message", (data) => { clearTimeout(timer); JSON.parse(String(data)).type === "auth-ok" ? resolve() : reject(new Error("authentication failed")); });
    });
    socket.send(JSON.stringify({ type: "auth-proof", proof: authProof(token, challenge.challenge) }));
    await authenticated;

    const pending = client.callTool({ name: "alibaba_status", arguments: {} });
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bridge request was not sent")), 2000);
      socket.once("message", (data) => {
        clearTimeout(timer);
        resolve(String(data));
      });
    });
    const request = JSON.parse(raw);
    socket.send(JSON.stringify({ id: request.id, ok: true, result: { secret: token, accessMode: "write" } }));
    const connected = await pending;
    const connectedText = connected.content?.find((item) => item.type === "text")?.text ?? "";
    assert.notEqual(connected.isError, true);
    assert.match(connectedText, /\[redacted\]/);
    assert.equal(connectedText.includes(token), false);
    assert.match(connectedText, /"accessMode": "write"/);
    socket.close();
  } finally {
    await client.close().catch(() => {});
    await server?.close().catch(() => {});
    await bridge.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
