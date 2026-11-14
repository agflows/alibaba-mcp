# alibaba-mcp

Chrome extension and remote MCP server for your Alibaba messages. The extension connects out to the hosted relay at `wss://alibaba-mcp-proxy.leogruetzner.com/relay`. Claude, ChatGPT, and other MCP clients use `https://alibaba-mcp-proxy.leogruetzner.com/mcp`. The connector secret routes a client to your browser. Request and response data passes through the relay in memory; the relay is a trusted part of the system and does not intentionally persist message contents or the secret. This project does not read Alibaba cookies.

Access is one of **None**, **Read**, or **Read & write**. Read is the default. Agents are instructed to ask before sending, and the extension independently opens a browser confirmation showing the exact conversation and text before every real send.

## Installation

The extension is published as a `.crx` on GitHub, the same way [Chromium Web Store](https://github.com/NeverDecaf/chromium-web-store) is installed on ungoogled-chromium.

1. On ungoogled-chromium, open `chrome://flags/#extension-mime-request-handling` and set it to **Always prompt for install**.
2. Open [alibaba-mcp.crx](https://github.com/agflows/alibaba-mcp/releases/download/v0.2.0/alibaba-mcp.crx) and confirm the install prompt.

If that download is blocked, open `chrome://extensions`, turn on Developer mode, and drag the downloaded `.crx` onto the page. If drag-and-drop is blocked too, download [alibaba-mcp.zip](https://github.com/agflows/alibaba-mcp/releases/download/v0.2.0/alibaba-mcp.zip), unzip it, and choose **Load unpacked**.

Installed copies look for updates in [`updates.xml`](updates.xml). Chromium Web Store can install those updates when that extension is installed.

After the extension is installed, sign in to Alibaba and keep `https://message.alibaba.com/` open. Open the extension and choose **Copy instructions**. That text contains this browser's connector secret. Keep it private.

Add this server URL in Claude or ChatGPT:

`https://alibaba-mcp-proxy.leogruetzner.com/mcp`

On claude.ai or ChatGPT, choose OAuth and paste the connector secret on the sign-in page. The secret is not put in the address bar. Claude Code, Claude Desktop, and Cursor can use the copied JSON block instead. It is a normal Streamable HTTP MCP server with an `Authorization: Bearer` header.

A local companion is only needed when an agent on that computer should save an attachment file. It is not required for listing, reading, or sending.

Clone an immutable release tag, build it, and pipe the connector secret from the extension popup to the installer without putting it in the command line:

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/agflows/alibaba-mcp.git
cd alibaba-mcp
npm ci
read -rsp "Connector secret: " ALIBABA_MCP_PROXY_TOKEN; echo
printf %s "$ALIBABA_MCP_PROXY_TOKEN" | node dist/installer/index.js install --secret-stdin
unset ALIBABA_MCP_PROXY_TOKEN
```

`status` and `uninstall` are also supported. Installation fails closed when no connector secret is supplied. Configuration writes are atomic and existing Cursor configuration is backed up. `npm ci` builds the companion through the `prepare` script. The companion proves itself to the browser with a separate HMAC pairing secret.

### Developer installation

For local development, load `dist/extension` unpacked and run the installer with `--secret-stdin` as shown above. The extension id pinned by `keys/extension.pem` is accepted automatically. That private key is not in git. Without it, a new package gets a different id and will not update an existing install. `npm run package:extension` writes `dist/alibaba-mcp.crx` and `dist/alibaba-mcp.zip`.

The popup shows **Relay connected** while the extension has a live WebSocket to the hosted relay. This does not mean that a particular MCP client is currently connected. The connector secret is not placed in the WebSocket URL, popup, logs, or tool output. A local companion still uses a fresh HMAC challenge. A new companion state can be claimed once. If this browser loses that claim, the popup says **Companion already paired**. Quit the agent, delete the private state directory (`~/.config/alibaba-mcp`, or `$XDG_CONFIG_HOME/alibaba-mcp`), and start the agent again. The extension then pairs on its own. Remote MCP clients do not use that pairing state.

## Access and sending

| Level | Read conversations | Send messages |
| --- | --- | --- |
| None | No | No |
| Read | Yes | No |
| Read & write | Yes | Yes |

The service worker blocks a call before it reaches the page. Status still reports whether the tab is open when access is None, without message text. The popup's **Copy conversation** button copies the currently selected chat as readable plain text. It works with Read or Read & write access and is disabled with None.

`alibaba_send_message` is a real send. The server instructions and tool description tell the agent to show you the exact conversation and text and wait for a clear yes. The extension first resolves the conversation id to a contact and company name from the open tab's loaded conversation list and refuses the send if that id is not found there, so the approval window always names a recognizable recipient. It then opens its own approval window and will not send unless you approve that exact conversation and text. A retry or rewritten message needs a new browser approval. Switch to Read or None to disable sending entirely.

## Attachments

`alibaba_list_attachments` returns ids, names, and sizes for files in one conversation. `alibaba_download_attachment` saves one of those files on this computer and returns the local path, size, and sha256. `alibaba_clear_cache` deletes that local cache. It does not change anything on Alibaba.

The service worker asks the open page for the file address. That address must be `https://clouddisk.alibaba.com` or one of its subdomains. The fetch omits credentials, follows redirects, skips the cache, and sends no referrer. The signed address authorizes the download, so no browser cookies are sent to clouddisk or to OSS. Before the body is read, the final response address must still be clouddisk or an Alibaba OSS virtual host: `bucket.oss.aliyuncs.com` or `bucket.oss-region.aliyuncs.com`, HTTPS, with no user name and no port other than 443. Any other final host is rejected. Neither address is sent through the relay, written to the MCP result, or logged. Each file is capped at 100 MiB. The cache directory is mode `0700` and each file is mode `0600`. A download writes a private temporary file and renames it into place. Finished files older than 24 hours, and leftover temporary files older than 15 minutes, are removed on the next download. The server does not open or execute the files.

Chrome is given host access to `https://clouddisk.alibaba.com/*`, `https://*.clouddisk.alibaba.com/*`, and `https://*.aliyuncs.com/*` so the service worker can connect to those origins. The aliyuncs pattern is the narrowest Chrome host pattern that covers every OSS region. The fetch still refuses a final address that is not clouddisk or one of those OSS virtual hosts. The extension page CSP `connect-src` allows `wss://alibaba-mcp-proxy.leogruetzner.com` and those same attachment origins, and no other network destination. The extension does not request the `cookies` permission and does not read cookie values. Reload the unpacked extension after a permission or CSP change.

## Checks

```bash
npm test
npm run check
npm run dev
npm run package:extension
```

`npm test` builds the local test bundles and does not contact Alibaba. `npm run check` typechecks, tests, and rebuilds `dist/`. `npm run dev` rebuilds while you edit. `npm run package:extension` writes `dist/alibaba-mcp.crx` and `dist/alibaba-mcp.zip`. The CRX is the GitHub release install file. The zip is the unpacked fallback. Neither file contains source maps. Archive timestamps are fixed, so rebuilding the same tag with the same key produces byte-identical files; the proxy Dockerfile pins its base image by digest.

## What stays on this machine

The browser keeps the Alibaba session. The extension reads the open messages tab. A remote MCP client sends a tool call to the hosted HTTPS server, which delivers that call to the connected browser and returns the result. The relay can see and modify those frames while they are in memory, but the application does not intentionally persist message contents. Cloudflare and the hosting path can process network traffic and metadata. A local companion can save attachment files on that computer and requires a fresh HMAC proof before it accepts the browser. Details and remaining risks are in [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).
