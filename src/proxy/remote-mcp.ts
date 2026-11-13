import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAlibabaMcpServer } from "../server/app.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OAUTH_HOSTS = new Set(["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"]);
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 500;

type ClientRecord = { id: string; redirects: string[]; name: string; expires?: number };
type CodeRecord = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  roomKey: string;
  expires: number;
};
type TokenRecord = { roomKey: string; clientId: string; expires: number };
type FormRecord = { params: URLSearchParams; expires: number };

export type RemoteMcpDeps = {
  origin: () => string;
  roomKeyForSecret: (secret: string) => string | null;
  extensionReady: (roomKey: string) => boolean;
  callExtension: (roomKey: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export function createRemoteMcp(deps: RemoteMcpDeps) {
  const clients = new Map<string, ClientRecord>();
  const codes = new Map<string, CodeRecord>();
  const accessTokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, TokenRecord>();
  const forms = new Map<string, FormRecord>();

  function roomKeyForBearer(token: string): string | null {
    const access = accessTokens.get(token);
    if (access) {
      if (access.expires <= Date.now()) {
        accessTokens.delete(token);
        return null;
      }
      return access.roomKey;
    }
    if (!TOKEN_PATTERN.test(token)) return null;
    return deps.roomKeyForSecret(token);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = requestUrl(request);
    if (!url) return false;
    if (request.method === "GET" && isMetadataPath(url.pathname)) {
      sendJson(response, 200, metadata(url.pathname, deps.origin()));
      return true;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      await register(request, response);
      return true;
    }
    if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) {
      await authorize(request, response);
      return true;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      await token(request, response);
      return true;
    }
    if (url.pathname === "/mcp") {
      await mcp(request, response);
      return true;
    }
    return false;
  }

  async function register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const allowed = redirects.filter((item): item is string => typeof item === "string" && redirectAllowed(item));
    if (!allowed.length || allowed.length !== redirects.length) {
      sendJson(response, 400, { error: "invalid_redirect_uri" });
      return;
    }
    prune(clients);
    const id = randomBytes(32).toString("base64url");
    const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 80) : "MCP client";
    clients.set(id, { id, redirects: allowed, name });
    sendJson(response, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: allowed,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  async function authorize(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET") {
      const params = requestUrl(request)?.searchParams;
      if (!params || !validAuthorize(params)) {
        sendHtml(response, 400, page("This sign-in link is missing required OAuth fields.", ""));
        return;
      }
      const client = clients.get(params.get("client_id") ?? "");
      const redirect = params.get("redirect_uri") ?? "";
      if (!client || !client.redirects.includes(redirect)) {
        sendHtml(response, 400, page("This application is not registered for that redirect.", ""));
        return;
      }
      prune(forms);
      const nonce = randomBytes(32).toString("base64url");
      forms.set(nonce, { params, expires: Date.now() + 10 * 60 * 1000 });
      sendHtml(response, 200, signInPage(nonce, params));
      return;
    }
    const form = await readForm(request);
    const nonce = form.get("nonce") ?? "";
    const pending = forms.get(nonce);
    forms.delete(nonce);
    if (!pending || pending.expires <= Date.now()) {
      sendHtml(response, 400, page("This sign-in page expired. Start the connection again.", ""));
      return;
    }
    const secret = (form.get("secret") ?? "").trim();
    const roomKey = TOKEN_PATTERN.test(secret) ? deps.roomKeyForSecret(secret) : null;
    if (!roomKey || !deps.extensionReady(roomKey)) {
      sendHtml(response, 401, signInPage(freshNonce(pending.params), pending.params, "Open the Alibaba messenger tab, then paste the connector secret again."));
      return;
    }
    prune(codes);
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: pending.params.get("client_id") ?? "",
      redirectUri: pending.params.get("redirect_uri") ?? "",
      challenge: pending.params.get("code_challenge") ?? "",
      roomKey,
      expires: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(pending.params.get("redirect_uri") ?? "");
    target.searchParams.set("code", code);
    const state = pending.params.get("state");
    if (state) target.searchParams.set("state", state);
    response.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
    response.end();
  }

  async function token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const grant = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    const client = clients.get(clientId);
    if (!client) {
      sendJson(response, 400, { error: "invalid_client" });
      return;
    }
    if (grant === "authorization_code") {
      const record = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !record ||
        record.expires <= Date.now() ||
        record.clientId !== clientId ||
        record.redirectUri !== (form.get("redirect_uri") ?? "") ||
        !pkce(verifier, record.challenge)
      ) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(response, 200, issueTokens(record.roomKey, clientId));
      return;
    }
    if (grant === "refresh_token") {
      const current = form.get("refresh_token") ?? "";
      const record = refreshTokens.get(current);
      refreshTokens.delete(current);
      if (!record || record.expires <= Date.now() || record.clientId !== clientId) {
        sendJson(response, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(response, 200, issueTokens(record.roomKey, clientId));
      return;
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  }

  function issueTokens(roomKey: string, clientId: string) {
    prune(accessTokens);
    prune(refreshTokens);
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    accessTokens.set(access, { roomKey, clientId, expires: Date.now() + ACCESS_TTL_MS });
    refreshTokens.set(refresh, { roomKey, clientId, expires: Date.now() + REFRESH_TTL_MS });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
    };
  }

  async function mcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const roomKey = token ? roomKeyForBearer(token) : null;
    if (!roomKey) {
      const metadataUrl = `${deps.origin()}/.well-known/oauth-protected-resource`;
      response.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      });
      response.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    const server = createAlibabaMcpServer({
      sanitize: (message) => (token ? message.split(token).join("[redacted]") : message),
      call: (method, params) => deps.callExtension(roomKey, method, params ?? {}),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  }

  function freshNonce(params: URLSearchParams): string {
    const nonce = randomBytes(32).toString("base64url");
    forms.set(nonce, { params, expires: Date.now() + 10 * 60 * 1000 });
    return nonce;
  }

  return { handle };
}

function metadata(pathname: string, origin: string): Record<string, unknown> {
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    };
  }
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["alibaba"],
  };
}

function isMetadataPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp" ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-authorization-server/mcp"
  );
}

function validAuthorize(params: URLSearchParams): boolean {
  return (
    params.get("response_type") === "code" &&
    Boolean(params.get("client_id")) &&
    Boolean(params.get("redirect_uri")) &&
    params.get("code_challenge_method") === "S256" &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(params.get("code_challenge") ?? "") &&
    (params.get("state") ?? "").length <= 1024
  );
}

function redirectAllowed(value: string): boolean {
  if (value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && LOOPBACK.has(host)) return true;
  if (url.protocol !== "https:") return false;
  return OAUTH_HOSTS.has(host) || [...OAUTH_HOSTS].some((item) => host.endsWith(`.${item}`));
}

function pkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(digest);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signInPage(nonce: string, params: URLSearchParams, error = ""): string {
  const fields = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type"]
    .map((name) => hidden(name, params.get(name) ?? ""))
    .join("");
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return page(
    "Connect Alibaba",
    `${notice}<form method="post" action="/authorize"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}">${fields}<label>Connector secret<input name="secret" type="password" autocomplete="off" required></label><button type="submit">Connect</button></form><p>Paste the secret from the alibaba-mcp extension. It stays in this request and is not put in the address bar.</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.4 system-ui,sans-serif;margin:2rem auto;max-width:32rem;padding:0 1rem}label,input,button{display:block;width:100%}input,button{font:inherit;margin:.5rem 0 1rem;padding:.6rem}.error{color:#9b1c1c}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(html);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readRaw(request);
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRaw(request));
}

function readRaw(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function prune<T extends { expires?: number }>(records: Map<string, T>): void {
  const now = Date.now();
  for (const [key, record] of records) {
    if (record.expires !== undefined && record.expires <= now) records.delete(key);
  }
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) return;
    records.delete(oldest);
  }
}
