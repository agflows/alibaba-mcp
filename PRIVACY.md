# Privacy policy

alibaba-mcp is an open-source Chrome extension, hosted relay, remote MCP server, and optional local attachment companion. The project does not sell personal data and does not include analytics, advertising, or telemetry.

## Data the service processes

When an MCP client calls a tool, the extension and hosted relay can process Alibaba conversation text, supplier and company names, conversation identifiers, timestamps, attachment names and sizes, access settings, and tool results. If the local companion downloads an attachment, the attachment bytes pass from Chrome through the relay to that companion and are written to its private local cache.

The extension uses the Alibaba session already open in Chrome. It does not request Chrome's `cookies` permission, read `document.cookie`, ask for an Alibaba password, or export cookie values. Signed Alibaba attachment addresses stay inside the extension and are not returned to the MCP client or written to application logs. Attachment requests omit browser credentials.

## Hosted relay and subprocessors

The extension connects to `wss://alibaba-mcp-proxy.leogruetzner.com/relay`. Remote MCP clients connect to `https://alibaba-mcp-proxy.leogruetzner.com/mcp`. The hosted relay routes requests and responses and can see their plaintext while they are in memory. The relay operator and any infrastructure on the TLS path are therefore trusted to process—and technically capable of modifying—those operations. The public endpoint is delivered through Cloudflare, which can process network metadata and encrypted traffic according to its own policies.

The hosted relay does not intentionally write conversation content, attachment bytes, connector secrets, OAuth codes, or OAuth tokens to persistent storage. Relay frames may be buffered briefly in memory until the other peer connects and are dropped when the connection closes. OAuth client registrations, authorization codes, access tokens, and refresh tokens are held in server memory and disappear when the relay restarts. Hosting and reverse-proxy infrastructure may retain ordinary security and network logs; application logs are designed not to include message contents or credentials.

An MCP client or model provider may receive conversation text and other tool results and process them under its own privacy policy. Users should review the privacy terms of Claude, ChatGPT, Cursor, or any other connected client.

## Credentials and controls

The connector secret is a long-lived capability that routes a client to one browser. It is generated in the extension, stored in `chrome.storage.local`, copied only when the user chooses **Copy instructions**, and sent to the hosted relay during WebSocket setup or OAuth sign-in. When the optional companion installer registers Cursor, it also stores that secret in Cursor's local MCP configuration as `ALIBABA_MCP_PROXY_TOKEN`; the configuration and timestamped backups are readable by the user's operating-system account. Treat it like a password. The popup's **Disconnect all clients** action rotates it; existing Bearer credentials and OAuth sessions can no longer reach the browser after rotation.

Chat access is one of None, Read, or Read & write. The default is Read. Every send requires a separate browser confirmation showing the exact conversation and message. Downloaded attachments use a private local cache and expire automatically.

The optional local companion has a separate pairing secret in a private state directory. Its cache directory is mode `0700`, files are mode `0600`, and finished files expire after 24 hours.

## Contact and security reports

Source code, deployment files, and security details are available at https://github.com/agflows/alibaba-mcp. Security reports should use the repository's GitHub Security Advisory/private vulnerability reporting channel when available. If that channel is unavailable, open a minimal issue that does not include secrets or exploit details and ask the maintainer for a private contact method.
