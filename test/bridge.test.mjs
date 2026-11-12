import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  BridgeConfigError,
  ExtensionBridge,
  createPairingToken,
  isLoopbackAddress,
  readBridgeConfigFromEnv,
  tokensMatch,
} from "../.test-build/app.mjs";

const extensionId = "b".repeat(32);

function bridgeOptions(token, extra = {}) {
  return {
    port: 0,
    token,
    extensionId,
    requestTimeoutMs: 300,
    heartbeatMs: 60_000,
    staleAfterMs: 60_000,
    ...extra,
  };
}

function connectClient(bridge, token, origin = `chrome-extension://${extensionId}`) {
  const options = origin ? { origin } : {};
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${encodeURIComponent(token)}`, options);
  socket.on("error", () => {});
  return socket;
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket open")), 2000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("socket closed before open"));
    });
  });
}

function closed(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket close")), 2000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket message")), 2000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
}

test("config rejects missing, weak, and unbound credentials without echoing them", () => {
  assert.throws(() => readBridgeConfigFromEnv({}), /ALIBABA_MCP_TOKEN is missing/);
  assert.throws(() => readBridgeConfigFromEnv({ ALIBABA_MCP_TOKEN: "not-a-token" }), (error) => {
    assert.equal(error instanceof BridgeConfigError, true);
    assert.equal(error.message.includes("not-a-token"), false);
    return true;
  });
  const token = "c".repeat(40);
  assert.throws(
    () => readBridgeConfigFromEnv({ ALIBABA_MCP_TOKEN: token, ALIBABA_MCP_EXTENSION_ID: "nope" }),
    (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /ALIBABA_MCP_EXTENSION_ID/);
      return true;
    },
  );
  assert.throws(
    () =>
      readBridgeConfigFromEnv({
        ALIBABA_MCP_TOKEN: token,
        ALIBABA_MCP_EXTENSION_ID: extensionId,
        ALIBABA_MCP_PORT: "80",
      }),
    /1024/,
  );
  const config = readBridgeConfigFromEnv({
    ALIBABA_MCP_TOKEN: token,
    ALIBABA_MCP_EXTENSION_ID: extensionId,
  });
  assert.equal(config.port, 17873);
  assert.equal(tokensMatch(token, token), true);
  const flipped = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(tokensMatch(token, flipped), false);
  assert.equal(tokensMatch("a".repeat(32), "a".repeat(43)), false);
  assert.equal(tokensMatch("", ""), false);
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("10.1.2.3"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("bridge listens on localhost and accepts only the paired extension", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token));
  try {
    await bridge.ready;
    assert.equal(bridge.host, "127.0.0.1");
    assert.ok(bridge.port > 0);

    const rejected = [
      connectClient(bridge, "d".repeat(32)),
      connectClient(bridge, token, "https://evil.example"),
      connectClient(bridge, token, `chrome-extension://${"e".repeat(32)}`),
      connectClient(bridge, token, `chrome-extension://${extensionId}/`),
      connectClient(bridge, token, null),
    ];
    const wrongPath = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge?token=${encodeURIComponent(token)}`, {
      origin: `chrome-extension://${extensionId}`,
    });
    const extraParam = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${encodeURIComponent(token)}&extra=1`, {
      origin: `chrome-extension://${extensionId}`,
    });
    wrongPath.on("error", () => {});
    extraParam.on("error", () => {});
    rejected.push(wrongPath, extraParam);
    await Promise.all(rejected.map((socket) => closed(socket)));
    assert.equal(bridge.connected, false);

    const socket = connectClient(bridge, token);
    await opened(socket);
    assert.equal(bridge.connected, true);
    socket.send(JSON.stringify({ type: "ping" }));
    assert.deepEqual(JSON.parse(await nextMessage(socket)), { type: "pong" });

    const pending = bridge.call("get_status");
    const request = JSON.parse(await nextMessage(socket));
    assert.equal(request.method, "get_status");
    assert.equal(JSON.stringify(request).includes(token), false);
    socket.send(JSON.stringify({ id: request.id, ok: true, result: { accessMode: "write" } }));
    assert.deepEqual(await pending, { accessMode: "write" });
    socket.close();
    await closed(socket);
  } finally {
    await bridge.close();
  }
});

test("pending calls fail when the extension drops or times out", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token, { requestTimeoutMs: 120 }));
  try {
    await bridge.ready;
    await assert.rejects(bridge.call("get_status"), /not connected/i);

    const timeoutSocket = connectClient(bridge, token);
    await opened(timeoutSocket);
    const timedOut = bridge.call("list_conversations", { limit: 1 });
    await nextMessage(timeoutSocket);
    await assert.rejects(timedOut, /Timed out waiting/);
    timeoutSocket.close();
    await closed(timeoutSocket);

    const socket = connectClient(bridge, token);
    await opened(socket);
    const dropped = bridge.call("get_conversation", { conversationId: "c1" });
    await nextMessage(socket);
    socket.close();
    await assert.rejects(dropped, /disconnected/i);
  } finally {
    await bridge.close();
  }
});

test("a replacement connection supersedes the previous extension socket", async () => {
  const token = createPairingToken();
  const bridge = new ExtensionBridge(bridgeOptions(token));
  try {
    await bridge.ready;
    const first = connectClient(bridge, token);
    await opened(first);
    const replaced = bridge.call("get_status");
    const rejection = assert.rejects(replaced, /reconnected/i);
    await nextMessage(first);

    const second = connectClient(bridge, token);
    await opened(second);
    await rejection;
    await closed(first);

    const pending = bridge.call("get_status");
    const request = JSON.parse(await nextMessage(second));
    second.send(JSON.stringify({ id: request.id, ok: false, error: `failed ${token}` }));
    await assert.rejects(pending, (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
    second.close();
  } finally {
    await bridge.close();
  }
});
