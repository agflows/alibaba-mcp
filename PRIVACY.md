# Privacy policy

alibaba-mcp is a local browser extension and companion application. It has no hosted relay and does not sell data.

The extension can process conversation text, supplier names, timestamps, attachment metadata, and attachment file bytes when requested. This data moves from the open Alibaba Messages tab to the extension, then over an authenticated loopback connection to the local companion and the MCP client selected by the user. The MCP client or model provider may process data under its own privacy policy.

Alibaba passwords and cookie values are not collected. The extension does not request Chrome's `cookies` permission. Signed attachment addresses remain inside the extension and are not returned to the MCP client. Attachment requests omit browser credentials.

Access is controlled by None, Read, and Read & write modes. Downloaded files use a private local cache and expire automatically. Pairing credentials are generated locally, stored in private local storage, and are not shown to the user or included in MCP configuration.

The project does not include analytics, advertising, remote code, or telemetry. Source code and security details are available at https://github.com/agflows/alibaba-mcp.

Questions and security reports may be submitted through the repository's private issue or security-reporting channel.
