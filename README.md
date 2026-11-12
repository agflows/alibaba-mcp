# alibaba-mcp

Local Chrome extension and MCP server for your Alibaba messages. The extension runs in your browser, the server listens on `127.0.0.1:17873`, and your agent talks to that server over stdio. This project does not run a hosted service and does not read Alibaba cookies.

Access is one of **None**, **Read**, or **Read & write**. Read & write is the default. Agents are instructed to ask you before they send a message. Set the extension to Read or None when you want sending to be impossible.

## Installation

The extension is published as a `.crx` on GitHub, the same way [Chromium Web Store](https://github.com/NeverDecaf/chromium-web-store) is installed on ungoogled-chromium.

1. On ungoogled-chromium, open `chrome://flags/#extension-mime-request-handling` and set it to **Always prompt for install**.
2. Open [alibaba-mcp.crx](https://github.com/agflows/alibaba-mcp/releases/download/v0.1.0/alibaba-mcp.crx) and confirm the install prompt.

If that download is blocked, open `chrome://extensions`, turn on Developer mode, and drag the downloaded `.crx` onto the page. If drag-and-drop is blocked too, download [alibaba-mcp.zip](https://github.com/agflows/alibaba-mcp/releases/download/v0.1.0/alibaba-mcp.zip), unzip it, and choose **Load unpacked**.

Installed copies look for updates in [`updates.xml`](updates.xml). Chromium Web Store can install those updates when that extension is installed.

The extension only talks to a companion process on this computer. After the extension is installed:

```bash
git clone https://github.com/agflows/alibaba-mcp.git
cd alibaba-mcp
npm ci
node dist/installer/index.js install
```

Restart Cursor, sign in to Alibaba, and keep `https://message.alibaba.com/` open. The companion registers the MCP server automatically. The bridge creates its own private 32-byte pairing secret, and the extension pairs automatically. Users never copy tokens, environment variables, JSON, paths, or extension ids.

`status` and `uninstall` are also supported. Configuration writes are atomic and existing Cursor configuration is backed up. `npm ci` builds the companion through the `prepare` script.

### Developer installation

For local development, load `dist/extension` unpacked and run `node dist/installer/index.js install`. The extension id pinned by `keys/extension.pem` is accepted automatically. That private key is not in git. Without it, a new package gets a different id and will not update an existing install. `npm run package:extension` writes `dist/alibaba-mcp.crx` and `dist/alibaba-mcp.zip`.

The popup shows **Securely connected** after the agent launches the companion MCP process. Pairing uses a fresh HMAC challenge; the secret is not placed in the WebSocket URL, popup, MCP configuration, logs, or tool output. A new companion state can be claimed once. If this browser loses that claim, the popup says **Companion already paired**. Quit the agent, delete the private state directory (`~/.config/alibaba-mcp`, or `$XDG_CONFIG_HOME/alibaba-mcp`), and start the agent again. The extension then pairs on its own.

## Access and sending

| Level | Read conversations | Send messages |
| --- | --- | --- |
| None | No | No |
| Read | Yes | No |
| Read & write | Yes | Yes |

The service worker blocks a call before it reaches the page. Status still reports whether the tab is open when access is None, without message text. The popup's **Copy conversation** button copies the currently selected chat as readable plain text. It works with Read or Read & write access and is disabled with None.

`alibaba_send_message` is a real send. The server instructions and tool description tell the agent to show you the exact conversation and text and wait for a clear yes. That is an instruction to the agent. The extension setting is the hard stop: switch to Read or None when sending must be impossible.

## Attachments

`alibaba_list_attachments` returns ids, names, and sizes for files in one conversation. `alibaba_download_attachment` saves one of those files on this computer and returns the local path, size, and sha256. `alibaba_clear_cache` deletes that local cache. It does not change anything on Alibaba.

The service worker asks the open page for the file address. That address must be `https://clouddisk.alibaba.com` or one of its subdomains. The fetch omits credentials, follows redirects, skips the cache, and sends no referrer. The signed address authorizes the download, so no browser cookies are sent to clouddisk or to OSS. Before the body is read, the final response address must still be clouddisk or an Alibaba OSS virtual host: `bucket.oss.aliyuncs.com` or `bucket.oss-region.aliyuncs.com`, HTTPS, with no user name and no port other than 443. Any other final host is rejected. Neither address is sent on the localhost socket, written to the MCP result, or logged. Each file is capped at 100 MiB. The cache directory is mode `0700` and each file is mode `0600`. A download writes a private temporary file and renames it into place. Finished files older than 24 hours, and leftover temporary files older than 15 minutes, are removed on the next download. The server does not open or execute the files.

Chrome is given host access to `https://clouddisk.alibaba.com/*`, `https://*.clouddisk.alibaba.com/*`, and `https://*.aliyuncs.com/*` so the service worker can connect to those origins. The aliyuncs pattern is the narrowest Chrome host pattern that covers every OSS region. The fetch still refuses a final address that is not clouddisk or one of those OSS virtual hosts. The extension page CSP `connect-src` allows the localhost bridge and those same attachment origins, and no other network destination. The extension does not request the `cookies` permission and does not read cookie values. Reload the unpacked extension after a permission or CSP change.

## Checks

```bash
npm test
npm run check
npm run dev
npm run package:extension
```

`npm test` builds the local test bundles and does not contact Alibaba. `npm run check` typechecks, tests, and rebuilds `dist/`. `npm run dev` rebuilds while you edit. `npm run package:extension` writes `dist/alibaba-mcp.crx` and `dist/alibaba-mcp.zip`. The CRX is the GitHub release install file. The zip is the unpacked fallback. Neither file contains source maps.

## What stays on this machine

The browser keeps the Alibaba session. The extension reads the open messages tab and sends text to the agent only over the localhost socket. The server requires loopback, an allowlisted Chrome extension origin, and a fresh HMAC proof before accepting commands. Details and remaining risks are in [SECURITY.md](SECURITY.md).
