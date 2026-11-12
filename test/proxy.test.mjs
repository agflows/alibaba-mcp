import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startProxy } from "../.test-build/proxy.mjs";
import { BridgeConfigError, ExtensionBridge, createPairingToken, authProof } from "../.test-build/app.mjs";

const extensionId = "c".repeat(32);

function opened(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("open timeout")), 2000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function closed(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else socket.once("close", () => resolve());
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 2000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
  });
}

test("proxy relays both peers and ignores the routing secret after hello", async () => {
  const proxy = await startProxy();
  const token = createPairingToken();
  const url = `ws://127.0.0.1:${proxy.port}/relay`;
  const agent = new WebSocket(url);
  const extension = new WebSocket(url);
  agent.on("error", () => {});
  extension.on("error", () => {});
  const agentReady = opened(agent);
  const extensionReady = opened(extension);
  try {
    const health = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");
    assert.equal((await fetch(`http://127.0.0.1:${proxy.port}/`)).status, 404);

    await Promise.all([agentReady, extensionReady]);
    agent.send(JSON.stringify({ type: "proxy-hello", role: "agent", token }));
    const buffered = nextMessage(extension);
    agent.send(JSON.stringify({ type: "auth-challenge", challenge: "abc" }));
    extension.send(JSON.stringify({ type: "proxy-hello", role: "extension", token }));
    const forwarded = await buffered;
    assert.equal(forwarded.isBinary, false);
    assert.deepEqual(JSON.parse(String(forwarded.data)), { type: "auth-challenge", challenge: "abc" });

    const binary = Buffer.from([9, 8, 7, 6]);
    const fromExtension = nextMessage(agent);
    extension.send(binary);
    const received = await fromExtension;
    assert.equal(received.isBinary, true);
    assert.deepEqual(Buffer.from(received.data), binary);

    const stranger = new WebSocket(url);
    stranger.on("error", () => {});
    await opened(stranger);
    stranger.send(JSON.stringify({ type: "proxy-hello", role: "extension", token: createPairingToken() }));
    const leaked = await Promise.race([
      nextMessage(stranger).then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(leaked, false);
    agent.send(JSON.stringify({ type: "auth-ok" }));
    stranger.close();
    extension.close();
    await closed(agent);
  } finally {
    agent.close();
    extension.close();
    await proxy.close();
  }
});

test("proxy rejects a routing secret in the url and a bad hello", async () => {
  const proxy = await startProxy();
  try {
    const queried = new WebSocket(`ws://127.0.0.1:${proxy.port}/relay?token=${createPairingToken()}`);
    queried.on("error", () => {});
    await closed(queried);
    const bad = new WebSocket(`ws://127.0.0.1:${proxy.port}/relay`);
    bad.on("error", () => {});
    await opened(bad);
    const finished = closed(bad);
    bad.send(JSON.stringify({ type: "proxy-hello", role: "extension", token: "short" }));
    await finished;
  } finally {
    await proxy.close();
  }
});

test("companion reaches the extension through the relay and nowhere else", async () => {
  const proxy = await startProxy();
  const routing = createPairingToken();
  const pairing = createPairingToken();
  const bridge = new ExtensionBridge({
    port: 0,
    token: pairing,
    extensionIds: [extensionId],
    requestTimeoutMs: 500,
    heartbeatMs: 60_000,
    staleAfterMs: 60_000,
  });
  const extension = new WebSocket(`ws://127.0.0.1:${proxy.port}/relay`);
  extension.on("error", () => {});
  try {
    await bridge.ready;
    assert.throws(() => bridge.connectProxy("wss://evil.example/relay", routing), BridgeConfigError);
    assert.throws(() => bridge.connectProxy("ws://1.2.3.4:9/relay", routing), BridgeConfigError);
    assert.throws(() => bridge.connectProxy(`ws://127.0.0.1:${proxy.port}/relay?token=${routing}`, routing), BridgeConfigError);
    bridge.connectProxy(`ws://127.0.0.1:${proxy.port}/relay`, routing);
    await opened(extension);
    extension.send(JSON.stringify({ type: "proxy-hello", role: "extension", token: routing }));
    const challenge = JSON.parse(String((await nextMessage(extension)).data));
    assert.equal(challenge.type, "auth-challenge");
    extension.send(JSON.stringify({ type: "auth-proof", proof: authProof(pairing, challenge.challenge) }));
    assert.equal(JSON.parse(String((await nextMessage(extension)).data)).type, "auth-ok");
    assert.equal(bridge.connected, true);
  } finally {
    extension.close();
    await bridge.close();
    await proxy.close();
  }
});
