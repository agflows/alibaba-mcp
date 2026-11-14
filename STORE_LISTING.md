# Chrome Web Store listing draft

The GitHub release includes a CRX whose manifest `update_url` points at `updates.xml`. Remove `update_url` before submitting a separate Chrome Web Store package.

## Name
alibaba-mcp

## Short description
Connect Alibaba Messages to an MCP client with read-only defaults and browser-confirmed sends.

## Detailed description
alibaba-mcp lets Claude, ChatGPT, Cursor, and other MCP clients list and read Alibaba supplier conversations and—only when Read & write is enabled—request message sends. The extension uses the Alibaba session already open in Chrome. It does not ask for an Alibaba password, export cookies, or request Chrome's cookie permission.

The default access level is Read. Every real send opens a browser confirmation that shows the exact conversation and exact message. The user must approve that dialog before the extension contacts Alibaba.

The extension connects to the hosted relay at `alibaba-mcp-proxy.leogruetzner.com`. Conversation data and tool calls pass through that relay while a request is active. The relay is required for remote MCP clients and is a trusted part of the system; details are in `PRIVACY.md` and `SECURITY.md`. The connector secret routes a client to one browser and can be rotated with **Disconnect all clients**.

A local attachment companion is optional. It is required only when a client on that computer should save attachment files to a private local cache. Listing, reading, and sending use the remote Streamable HTTP MCP server without the companion.

## Single purpose
Controlled MCP access to the user's Alibaba Messages conversations.

## Permission justifications
- `storage`: stores the selected access mode, local-companion pairing state, and this browser's connector secret.
- `alarms`: wakes the Manifest V3 service worker so it can reconnect to the hosted relay.
- `message.alibaba.com`: reads conversations from the signed-in messenger page and sends only after Read & write is enabled and the user approves the browser confirmation.
- `clouddisk.alibaba.com` and `*.aliyuncs.com`: downloads user-requested chat attachments without browser credentials; final OSS hosts are validated in code.
- `alibaba-mcp-proxy.leogruetzner.com`: connects the extension to the hosted relay and remote MCP endpoint.

## Data-use disclosures
- Processes Alibaba conversation text, supplier names, identifiers, timestamps, and attachment metadata only when requested by a connected MCP client.
- Sends those request and response frames through the hosted relay and Cloudflare delivery path.
- Does not intentionally persist conversation content or attachment bytes on the hosted relay.
- Does not sell data and includes no analytics, ads, or telemetry.
- Stores connector credentials locally in Chrome; the user can rotate them.
- Optional attachment downloads are stored in a private local cache and expire automatically.

## Release checklist
- Remove `update_url` from the Chrome Web Store upload.
- Publish `PRIVACY.md` at a stable public URL and complete store data-use disclosures consistently.
- Run CI, package checks, and CRX/source artifact comparison from the release tag.
- Sign the release tag and publish checksums/provenance for release artifacts.
- Publish and document the optional local attachment companion.
- Provide 1280x800 or 640x400 screenshots and a 440x280 promotional tile.
