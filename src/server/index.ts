import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readBridgeConfigFromEnv } from "./auth.js";
import { createAlibabaMcpServer } from "./app.js";
import { ExtensionBridge } from "./bridge.js";

if (Number(process.versions.node.split(".")[0]) < 20) {
  console.error("alibaba-mcp: Node.js 20 or newer is required.");
  process.exit(1);
}

const configuredToken = process.env.ALIBABA_MCP_TOKEN;
let bridge: ExtensionBridge | undefined;
let shuttingDown = false;

try {
  const config = readBridgeConfigFromEnv(process.env);
  bridge = new ExtensionBridge(config);
  await bridge.ready;
  const server = createAlibabaMcpServer(bridge, {
    cacheDir: process.env.ALIBABA_MCP_CACHE_DIR,
  });

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close().catch(() => {});
    await bridge?.close().catch(() => {});
    process.exit(code);
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.stdin.on("end", () => {
    void shutdown(0);
  });

  await server.connect(new StdioServerTransport());
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to start.";
  console.error(`alibaba-mcp: ${redact(message, configuredToken)}`);
  await bridge?.close().catch(() => {});
  process.exit(1);
}

function redact(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}
