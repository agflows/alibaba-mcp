import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import { startProxy } from "../.test-build/proxy.mjs";
import { createPairingToken } from "../.test-build/protocol.mjs";

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

function connectExtension(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  socket.on("error", () => {});
  const seen = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(String(data));
    seen.push(message);
    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (typeof message.id === "string" && typeof message.method === "string") {
      socket.send(JSON.stringify({ id: message.id, ok: true, result: { echoed: message.method } }));
    }
  });
  return opened(socket).then(
    () =>
      new Promise((resolve, reject) => {
        socket.send(JSON.stringify({ type: "proxy-hello", role: "extension", token }), (error) => {
          if (error) reject(error);
          else resolve({ socket, seen });
        });
      }),
  );
}

async function waitForRoom(port, token) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
    });
    await response.body?.cancel();
    if (response.status !== 401) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The browser did not join the relay.");
}

async function connectClient(port, token) {
  const client = new Client({ name: "remote-mcp-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

test("remote MCP is Streamable HTTP with bearer auth and stays inside one browser", { timeout: 20_000 }, async () => {
  const proxy = await startProxy();
  const origin = `http://127.0.0.1:${proxy.port}`;
  const token = createPairingToken();
  const otherToken = createPairingToken();
  const extension = await connectExtension(proxy.port, token);
  const other = await connectExtension(proxy.port, otherToken);
  let client;
  try {
    const denied = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${origin}/\\.well-known/oauth-protected-resource"`));
    assert.equal((await denied.text()).includes("a".repeat(43)), false);

    const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
    assert.equal(metadata.resource, `${origin}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [origin]);
    const authorization = await (await fetch(`${origin}/.well-known/oauth-authorization-server/mcp`)).json();
    assert.equal(authorization.registration_endpoint, `${origin}/register`);
    assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(authorization.token_endpoint_auth_methods_supported, ["none"]);

    const rejected = await fetch(`${origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
    });
    assert.equal(rejected.status, 400);

    await waitForRoom(proxy.port, token);
    client = await connectClient(proxy.port, token);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.includes("alibaba_status"), true);
    assert.equal(names.includes("alibaba_send_message"), true);
    assert.equal(names.includes("alibaba_download_attachment"), false);
    assert.equal(names.includes("alibaba_clear_cache"), false);

    const status = await client.callTool({ name: "alibaba_status", arguments: {} });
    const text = status.content?.find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /get_status/);
    assert.equal(status.isError, undefined);
    assert.equal(other.seen.some((message) => message.method === "get_status"), false);
    assert.equal(extension.seen.some((message) => message.method === "get_status"), true);

    const ping = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pong timeout")), 1000);
      const onMessage = (data) => {
        const message = JSON.parse(String(data));
        if (message.type !== "pong") return;
        clearTimeout(timer);
        extension.socket.off("message", onMessage);
        resolve();
      };
      extension.socket.on("message", onMessage);
    });
    extension.socket.send(JSON.stringify({ type: "ping" }));
    await ping;
  } finally {
    await client?.close();
    extension.socket.close();
    other.socket.close();
    await proxy.close();
  }
});

test("OAuth sign-in exchanges the connector secret once and rotates refresh tokens", { timeout: 20_000 }, async () => {
  const proxy = await startProxy();
  const origin = `http://127.0.0.1:${proxy.port}`;
  const token = createPairingToken();
  const extension = await connectExtension(proxy.port, token);
  let client;
  try {
    await waitForRoom(proxy.port, token);
    const registered = await fetch(`${origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:9/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registered.status, 201);
    const clientId = (await registered.json()).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:9/callback";
    const authorize = new URL(`${origin}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "browser-state");
    const page = await fetch(authorize);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(html.includes(token), false);
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    assert.ok(nonce);

    const wrong = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce, secret: "not-the-secret" }),
    });
    const wrongHtml = await wrong.text();
    assert.equal(wrong.status, 401);
    assert.equal(wrongHtml.includes(token), false);
    assert.equal(wrongHtml.includes("not-the-secret"), false);

    const retryNonce = wrongHtml.match(/name="nonce" value="([^"]+)"/)?.[1];
    const approved = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce: retryNonce, secret: token }),
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    const location = approved.headers.get("location") ?? "";
    assert.equal(location.includes(token), false);
    const redirected = new URL(location);
    assert.equal(redirected.origin + redirected.pathname, redirectUri);
    assert.equal(redirected.searchParams.get("state"), "browser-state");
    const code = redirected.searchParams.get("code");
    assert.ok(code);

    const badVerifier = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: randomBytes(32).toString("base64url"),
      }),
    });
    assert.equal(badVerifier.status, 400);

    const again = await fetch(authorize);
    const againHtml = await again.text();
    const againNonce = againHtml.match(/name="nonce" value="([^"]+)"/)?.[1];
    const second = await fetch(`${origin}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce: againNonce, secret: token }),
      redirect: "manual",
    });
    const secondCode = new URL(second.headers.get("location") ?? "").searchParams.get("code");
    const issued = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: secondCode ?? "",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    assert.equal(issued.status, 200);
    const tokens = await issued.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.access_token.includes(token), false);
    client = await connectClient(proxy.port, tokens.access_token);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === "alibaba_get_conversation"), true);

    const refreshed = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    });
    assert.equal(refreshed.status, 200);
    const reused = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }),
    });
    assert.equal(reused.status, 400);
  } finally {
    await client?.close();
    extension.socket.close();
    await proxy.close();
  }
});
