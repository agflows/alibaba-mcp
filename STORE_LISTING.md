# Chrome Web Store listing draft

The current release is the GitHub CRX described in the README. Its manifest `update_url` points at `updates.xml`, so this build is not a Chrome Web Store upload. Remove `update_url` before submitting a store package.

## Name
alibaba-mcp

## Short description
Connect your Alibaba Messages inbox to a local MCP agent with explicit access controls.

## Detailed description
alibaba-mcp lets a local AI agent list and read Alibaba supplier conversations, download chat attachments into a private local cache, and—only when enabled—send approved messages. The extension uses the Alibaba session already open in Chrome. It does not ask for an Alibaba password, export cookies, or use a hosted relay.

Access is always one of None, Read, or Read & write. The extension pairs automatically with the locally installed companion app. Pairing secrets are generated and stored locally and never appear in setup screens or MCP configuration.

A separate signed companion-app installer is required because Chrome extensions cannot install native software or configure external MCP clients.

## Single purpose
Controlled local access to the user's Alibaba Messages conversations for an MCP-compatible agent.

## Permission justifications
- `storage`: stores the selected access mode and automatic local-pairing secret.
- `alarms`: wakes the Manifest V3 service worker to reconnect to the local companion.
- `message.alibaba.com`: reads the visible inbox and sends only when Read & write is selected.
- `clouddisk.alibaba.com` and `*.aliyuncs.com`: downloads user-requested chat attachments without browser credentials; final OSS hosts are validated in code.

## Release checklist
- Upload a draft package and record the assigned Chrome Web Store extension id.
- Add that id to the companion's compiled allowlist before public release.
- Publish `PRIVACY.md` at a stable public URL.
- Build and sign companion installers for supported operating systems.
- Provide 1280x800 or 640x400 screenshots and a 440x280 promotional tile.
- Complete data-use disclosures consistently with `PRIVACY.md`.
