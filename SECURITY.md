# Security

alibaba-mcp is a local bridge. It is for one person, on one computer, between Chrome and an MCP agent. It is not a remote API and it is not a place to put an Alibaba password or cookie export.

## What it can do

With the extension set to Read, an agent can list and read conversations visible in an open `https://message.alibaba.com/` tab, list attachment names, and save those files into a private local cache. With Read & write, it can also send a message through that tab. The default is Read & write. None blocks both. Clearing the cache is local and does not need the extension to be connected.

Message text and downloaded file bytes cross two local hops: from the page or the browser fetch to the extension, then over `ws://127.0.0.1:17873` to the MCP server, then over stdio to the agent. This repository does not send that data anywhere else. The agent application you pair might send tool results, including a downloaded file if the agent reads it, to its model provider. Treat conversation text and attachment files accordingly.

The extension never requests the `cookies` permission, does not read `document.cookie`, and does not ask you to export a session. Sign in inside Chrome yourself. An attachment download starts from a signed `https://clouddisk.alibaba.com` address, or a subdomain of it, and the fetch omits credentials, follows redirects, and sends no referrer. No browser cookies are attached to clouddisk or to OSS. The signed address is the authorization. Chrome follows the redirect to OSS. Before any file bytes are read, the final response address must be clouddisk or an Alibaba OSS virtual host (`bucket.oss.aliyuncs.com` or `bucket.oss-region.aliyuncs.com`), HTTPS, with no user name and no non-443 port. A response with no readable final address is rejected. The signed address is dropped before any result or log leaves the service worker. The page script returns the clouddisk address only to this extension's background, not to the popup or the agent.

## Controls

- The WebSocket server binds to `127.0.0.1` only. It checks the socket's remote address and ignores forwarded headers. Do not put a reverse proxy in front of it.
- A connection must present `Origin: chrome-extension://ligjbkljdnlcjpfglgjmflggigiomlic` and the pairing token. The id comes from the public key in the manifest. The id is not a secret. The token is.
- The token is 32 random bytes, stored in `chrome.storage.local` (not sync), and compared by hashing both sides before `timingSafeEqual`. Short or empty tokens are rejected. The handshake URL may contain only the `token` query parameter.
- The popup copies the token into your MCP config. Rotate it in the popup to disconnect every previous config. Do not commit, log, or paste the token into a chat.
- Popup messages are accepted only from this extension's own pages. A content script on the Alibaba origin cannot ask the service worker for the token.
- Access is a single stored value: `none`, `read`, or `write`. The service worker checks it before it messages the page. Unknown stored values fall back to None. Missing values fall back to Read & write.
- While access is None, status does not include the tab URL or page diagnostics.
- Status URLs keep the path and drop the query string.
- Tool descriptions, server instructions, and the copied setup tell the agent to get your explicit approval for the exact conversation and text before `alibaba_send_message`. The approve-alibaba-send prompt repeats that requirement.
- Extension pages use a CSP that allows scripts only from the extension. `connect-src` allows `ws://127.0.0.1:17873` and the attachment origins `https://clouddisk.alibaba.com`, `https://*.clouddisk.alibaba.com`, and `https://*.aliyuncs.com`. No other network destination is listed. `message.alibaba.com` is not a connect target; the service worker reaches that tab through Chrome.
- Permissions are `alarms` and `storage`, plus host access to `https://message.alibaba.com/*`, `https://clouddisk.alibaba.com/*`, `https://*.clouddisk.alibaba.com/*`, and `https://*.aliyuncs.com/*`. Those hosts let the service worker connect to clouddisk and to OSS. `https://*.aliyuncs.com/*` is the smallest Chrome host pattern that covers OSS virtual hosts in every region. The fetch omits credentials on the whole request. Before reading the body, it accepts the final address only when that address is clouddisk or a validated OSS virtual host. The broad `tabs` permission is not used. The extension is not allowed in Incognito and does not expose `externally_connectable`.
- Attachment downloads are capped at 100 MiB, streamed in 256 KiB binary frames, and cancelled if the tool call is aborted, the socket closes, or the transfer stalls. A failed transfer deletes its temporary file. The cache directory is created at mode `0700` and rejected if it is a symlink, is not owned by you, or is group- or world-accessible. File names are stripped of paths and control characters. Each file is written as a unique temporary name at mode `0600` and renamed into place. Finished files expire after 24 hours. The process never opens the file with a viewer and never executes it. `alibaba_clear_cache` deletes regular files in that directory and does not follow symlinks.
- Bridge payloads are capped, pending calls are capped, and errors returned to the agent are redacted if they contain the token. The server logs to stderr and does not print the token. MCP stdio stays clean because startup errors go to stderr.
- `package.json` is private. Install from your own git remote with `npm ci` so the lockfile and `prepare` build are the bits you run.

## What this does not protect against

Explicit approval is an instruction to the agent, not a Chrome confirmation dialog. An agent that ignores it can send while access is Read & write. Use Read or None when you want the extension to make sending impossible.

A program running as you can read your MCP config, your Chrome profile, or the localhost socket. With the token, that program can forge the extension `Origin` header and take the single bridge connection. The token stops other websites and other extensions. It does not stop malware in your user account. The public extension id does not either.

Chrome can suspend an MV3 service worker and drop its WebSocket. The extension reconnects on browser startup, on install, when the Alibaba tab finishes loading, when the popup opens, and on a `chrome.alarms` wake. Chrome 120 and newer fires that alarm about every 30 seconds. Older Chrome may wait a minute. A tool call during the gap fails with a not-connected error. Retry after the popup shows **Agent bridge connected**. Protocol pings detect a half-open socket while the worker is alive; they do not keep Chrome from suspending it.

The Alibaba page can change its DOM. The content script only talks to the open tab. A hostile page still cannot call Chrome extension APIs, but it can show misleading UI. This project does not try to prove that a conversation id belongs to the supplier you think it does beyond what the page displays. Until the page exposes an attachment, list and download fail closed instead of guessing a URL.

A local program that already has your pairing token can receive the downloaded bytes over localhost, the same way it can receive message text. It still does not get the signed URL from this bridge. The token in the websocket query string is visible to other programs on this machine that can inspect your connections.

Source maps in `dist/extension` include local paths. That folder is for your machine. Do not upload the extension zip to a public store.

## Report a problem

If you find a way for a website, or for an extension other than this one, to read conversations or send messages without the pairing token, treat it as a vulnerability in this local bridge. Rotate the token and set access to None until you have a fixed build.
