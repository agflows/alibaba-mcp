# alibaba-mcp

Local Chrome extension and MCP server for your Alibaba messages. The extension runs in your browser, the server listens on `127.0.0.1:17873`, and your agent talks to that server over stdio. This project does not run a hosted service and does not read Alibaba cookies.

Access is one of **None**, **Read**, or **Read & write**. Read & write is the default. Agents are instructed to ask you before they send a message. Set the extension to Read or None when you want sending to be impossible.

## Setup

You need Node.js 20 or newer, Chrome 116 or newer (120 or newer reconnects faster), and a private checkout of this repo.

```bash
git clone git@your-host:your-org/alibaba-mcp.git
cd alibaba-mcp
npm ci
npm run check
```

`npm ci` installs the lockfile and builds `dist/` through the `prepare` script. Leave npm scripts enabled. Do not publish the package: `package.json` is `"private": true`.

1. Open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**. Select `dist/extension`.
2. Pin alibaba-mcp. The extension id stays `ligjbkljdnlcjpfglgjmflggigiomlic` because the manifest carries a public key. The pairing token is the secret.
3. Sign in to Alibaba yourself and leave `https://message.alibaba.com/` open in a normal Chrome window. The extension does not run in Incognito.
4. Open the extension popup and choose **Copy agent setup**. Replace `<PATH-TO-alibaba-mcp>` with the absolute path of this checkout. Paste the snippet into your MCP client, then restart the agent.

Cursor usually reads that snippet from `~/.cursor/mcp.json`. The copied block looks like this, with a real token and the extension id filled in:

```json
{
  "mcpServers": {
    "alibaba": {
      "command": "node",
      "args": ["/absolute/path/alibaba-mcp/dist/server/index.js"],
      "env": {
        "ALIBABA_MCP_TOKEN": "<pairing-token>",
        "ALIBABA_MCP_EXTENSION_ID": "ligjbkljdnlcjpfglgjmflggigiomlic"
      }
    }
  }
}
```

`node` must be on the agent's PATH. If it is not, set `command` to the absolute path from `command -v node`.

The popup shows **Agent bridge connected** when the agent has started the server and the extension has paired. Use `alibaba_status` first. Keep the Alibaba tab open while you work.

Optional: set `ALIBABA_MCP_CACHE_DIR` to an absolute directory if you do not want attachment files under `~/.cache/alibaba-mcp/attachments`. A relative path is rejected.

After a rebuild, choose **Reload** on `chrome://extensions` if the unpacked extension still has the previous scripts.

## Access and sending

| Level | Read conversations | Send messages |
| --- | --- | --- |
| None | No | No |
| Read | Yes | No |
| Read & write | Yes | Yes |

The service worker blocks a call before it reaches the page. Status still reports whether the tab is open when access is None, without message text.

`alibaba_send_message` is a real send. The server instructions, the tool description, and the copied setup all tell the agent to show you the exact conversation and text and wait for a clear yes. That is an instruction to the agent. The extension setting is the hard stop: switch to Read or None, or rotate the pairing token, and the previous agent config stops working until you copy the new one.

Do not commit the copied snippet. It contains the pairing token. `.env` files are gitignored; this project does not need one.

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

`npm test` builds the local test bundles and does not contact Alibaba. `npm run check` typechecks, tests, and rebuilds `dist/`. `npm run dev` rebuilds while you edit. `npm run package:extension` writes `dist/alibaba-mcp-extension.zip` for copying the unpacked extension to another machine you trust. Load that zip's `extension` folder unpacked. It is not a Chrome Web Store package.

## What stays on this machine

The browser keeps the Alibaba session. The extension reads the open messages tab and sends text to the agent only over the localhost socket. The server refuses every connection that is not from `127.0.0.1`, not from this extension's origin, or not holding the pairing token. Details and the remaining risks are in [SECURITY.md](SECURITY.md).
