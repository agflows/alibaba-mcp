# Security

alibaba-mcp is a local bridge. It is for one person, on one computer, between Chrome and an MCP agent. It is not a remote API and it is not a place to put an Alibaba password or cookie export.

## What it can do

With the extension set to Read, an agent can list and read conversations visible in an open `https://message.alibaba.com/` tab, list attachment names, and save those files into a private local cache. With Read & write, it can also send a message through that tab. The default is Read & write. None blocks both. Clearing the cache is local and does not need the extension to be connected.

Message text and downloaded file bytes cross the extension, then a private websocket relay at `wss://alibaba-mcp-proxy.leogruetzner.com/relay`, then the companion, then stdio to the agent. The relay forwards frames and does not store them. The machine running the relay and the TLS path in front of it can see those frames while the socket is open. The agent application you pair might send tool results, including a downloaded file if the agent reads it, to its model provider. Treat conversation text and attachment files accordingly.

The extension never requests the `cookies` permission, does not read `document.cookie`, and does not ask you to export a session. Sign in inside Chrome yourself. An attachment download starts from a signed `https://clouddisk.alibaba.com` address, or a subdomain of it, and the fetch omits credentials, follows redirects, and sends no referrer. No browser cookies are attached to clouddisk or to OSS. The signed address is the authorization. Chrome follows the redirect to OSS. Before any file bytes are read, the final response address must be clouddisk or an Alibaba OSS virtual host (`bucket.oss.aliyuncs.com` or `bucket.oss-region.aliyuncs.com`), HTTPS, with no user name and no non-443 port. A response with no readable final address is rejected. The signed address is dropped before any result or log leaves the service worker. The page script returns the clouddisk address only to this extension's background, not to the popup or the agent.

## Controls

- The companion's own WebSocket server binds to `127.0.0.1` only. It checks the socket's remote address and ignores forwarded headers. Do not put a reverse proxy in front of that local listener.
- The extension and the companion dial out to the relay. The relay accepts only `GET /health` and a websocket upgrade on `/relay` with no query string. The first frame must be a short hello carrying the routing secret. The secret is hashed for the room key and is not logged or stored. Each role has one socket; a new socket replaces the previous one. Frames are relayed, with a small memory buffer until the other side arrives, and are dropped when the socket closes. One side closing closes the other. The relay does not interpret the HMAC pairing that happens inside that pipe.
- A connection must come from loopback and an allowlisted `chrome-extension://` origin. The published CRX id is pinned in the manifest `key`. The private signing key is not in this repository.
- The server generates a 32-byte secret in its private state directory (`0700`, state file `0600`). A new state permits one origin-checked pairing claim; the claim is persisted before the extension receives the secret. A later claim is refused, and the popup reports that the companion is already paired. Delete that private state directory and restart the companion to pair again. The extension stores the secret in `chrome.storage.local`, never sync storage. A state file written before the claim flag existed is treated as already claimed.
- Every connection uses a fresh 32-byte nonce and HMAC-SHA256 proof. That pairing secret is not present in the WebSocket URL, popup, logs, or tool output. The separate relay secret is copied with the agent instructions and stored in the companion environment so the proxy can route this browser. Wrong and replayed HMAC proofs are rejected.
- Popup messages are accepted only from this extension's own pages. A content script on the Alibaba origin cannot request pairing state.
- Access is a single stored value: `none`, `read`, or `write`. The service worker checks it before it messages the page. Unknown stored values fall back to None. Missing values fall back to Read & write.
- While access is None, status does not include the tab URL or page diagnostics.
- Status URLs keep the path and drop the query string.
- Tool descriptions and server instructions tell the agent to get your explicit approval for the exact conversation and text before `alibaba_send_message`. The approve-alibaba-send prompt repeats that requirement.
- Extension pages use a CSP that allows scripts only from the extension. `connect-src` allows `wss://alibaba-mcp-proxy.leogruetzner.com` and the attachment origins `https://clouddisk.alibaba.com`, `https://*.clouddisk.alibaba.com`, and `https://*.aliyuncs.com`. No other network destination is listed. `message.alibaba.com` is not a connect target; the service worker reaches that tab through Chrome.
- Permissions are `alarms` and `storage`, plus host access to `https://message.alibaba.com/*`, `https://clouddisk.alibaba.com/*`, `https://*.clouddisk.alibaba.com/*`, and `https://*.aliyuncs.com/*`. Those hosts let the service worker connect to clouddisk and to OSS. `https://*.aliyuncs.com/*` is the smallest Chrome host pattern that covers OSS virtual hosts in every region. The fetch omits credentials on the whole request. Before reading the body, it accepts the final address only when that address is clouddisk or a validated OSS virtual host. The broad `tabs` permission is not used. The extension is not allowed in Incognito and does not expose `externally_connectable`.
- Attachment downloads are capped at 100 MiB, streamed in 256 KiB binary frames, and cancelled if the tool call is aborted, the socket closes, or the transfer stalls. A failed transfer deletes its temporary file. The cache directory is created at mode `0700` and rejected if it is a symlink, is not owned by you, or is group- or world-accessible. File names are stripped of paths and control characters. Each file is written as a unique temporary name at mode `0600` and renamed into place. Finished files expire after 24 hours. The process never opens the file with a viewer and never executes it. `alibaba_clear_cache` deletes regular files in that directory and does not follow symlinks.
- Bridge payloads and pending calls are capped. The server redacts its private pairing secret from errors, logs only to stderr, and keeps MCP stdio clean.
- `package.json` is private. Install from your own git remote with `npm ci` so the lockfile and `prepare` build are the bits you run.

## What this does not protect against

Explicit approval is an instruction to the agent, not a Chrome confirmation dialog. An agent that ignores it can send while access is Read & write. Use Read or None when you want the extension to make sending impossible.

A program running as you can read the private pairing state or Chrome profile and can impersonate either side. Automatic pairing and HMAC stop websites and unrelated extensions; they do not stop malware running as your user.

Chrome can suspend an MV3 service worker and drop its WebSocket. The extension reconnects on browser startup, on install, when the Alibaba tab finishes loading, when the popup opens, and on a `chrome.alarms` wake. Chrome 120 and newer fires that alarm about every 30 seconds. Older Chrome may wait a minute. A tool call during the gap fails with a not-connected error. Retry after the popup shows **Securely connected**. Protocol pings detect a half-open socket while the worker is alive; they do not keep Chrome from suspending it.

The Alibaba page can change its DOM. The content script only talks to the open tab. A hostile page still cannot call Chrome extension APIs, but it can show misleading UI. This project does not try to prove that a conversation id belongs to the supplier you think it does beyond what the page displays. Until the page exposes an attachment, list and download fail closed instead of guessing a URL.

A local program that can read the private pairing state can receive the same message and file bytes as the companion. Signed Alibaba download URLs still do not cross the bridge.

Development builds contain source maps. The Chrome Web Store package must omit them and must be reviewed and signed through the store.

## Report a problem

If you find a way for a website, or for an extension other than this one, to read conversations or send messages without completing pairing authentication, treat it as a vulnerability. Set access to None and stop the companion until you have a fixed build.
