import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicAttachmentList, readAttachmentId, safeAgentError } from "../shared/attachments.js";
import { AGENT_INSTRUCTIONS, SEND_APPROVAL_INSTRUCTION, type BridgeMethod } from "../shared/protocol.js";
import { resolveCacheDir, AttachmentCache } from "./cache.js";
import { ExtensionBridge } from "./bridge.js";
import { downloadToCache } from "./transfer.js";

export function createAlibabaMcpServer(bridge: ExtensionBridge, options: { cacheDir?: string } = {}): McpServer {
  const directory = resolveCacheDir(options.cacheDir);
  let opening: Promise<AttachmentCache> | undefined;
  const openCache = async () => {
    try {
      opening ??= AttachmentCache.open(directory);
      return await opening;
    } catch (error) {
      opening = undefined;
      throw error;
    }
  };
  const server = new McpServer(
    { name: "alibaba-mcp", version: "0.1.0" },
    { instructions: AGENT_INSTRUCTIONS },
  );

  const readonly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  server.registerTool(
    "alibaba_status",
    {
      title: "Alibaba status",
      description:
        "Report the local extension connection, the access level, and whether a message.alibaba.com tab is open. Page diagnostics are included only when access is read or read/write. This does not return conversation text.",
      inputSchema: {},
      annotations: readonly,
    },
    async () => attempt(bridge, () => bridge.call("get_status")),
  );

  server.registerTool(
    "alibaba_list_conversations",
    {
      title: "List Alibaba conversations",
      description: "List visible Alibaba conversations from the open Chrome tab. Requires read or read/write access in the extension.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        search: z.string().max(200).optional(),
      },
      annotations: readonly,
    },
    async ({ limit, search }) => attempt(bridge, () => bridge.call("list_conversations", { limit, search })),
  );

  server.registerTool(
    "alibaba_get_conversation",
    {
      title: "Read Alibaba conversation",
      description:
        "Read messages from one conversation in the open Chrome tab. Requires read or read/write access. Use an id from alibaba_list_conversations.",
      inputSchema: {
        conversationId: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: readonly,
    },
    async ({ conversationId, limit }) =>
      attempt(bridge, () => bridge.call("get_conversation", { conversationId, limit })),
  );

  server.registerTool(
    "alibaba_send_message",
    {
      title: "Send Alibaba message",
      description: `${SEND_APPROVAL_INSTRUCTION} Requires read/write access in the extension. This sends a real Alibaba message.`,
      inputSchema: {
        conversationId: z.string().min(1).max(500),
        text: z.string().min(1).max(10_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ conversationId, text }) =>
      attempt(bridge, () => bridge.call("send_message" satisfies BridgeMethod, { conversationId, text })),
  );

  server.registerTool(
    "alibaba_list_attachments",
    {
      title: "List Alibaba attachments",
      description:
        "List file attachments in one Alibaba conversation. Requires read or read/write access. Returns ids, names, and sizes only. Remote addresses stay in the browser.",
      inputSchema: {
        conversationId: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: readonly,
    },
    async ({ conversationId, limit }) =>
      attempt(bridge, async () => {
        const listed = publicAttachmentList(await bridge.call("list_attachments", { conversationId }));
        return { attachments: listed.attachments.slice(0, limit) };
      }),
  );

  server.registerTool(
    "alibaba_download_attachment",
    {
      title: "Download Alibaba attachment",
      description:
        "Save one attachment into the private local cache and return its local path, name, size, and sha256. Requires read or read/write access. Use an id from alibaba_list_attachments. Do not ask for or display the remote address.",
      inputSchema: {
        conversationId: z.string().min(1).max(300),
        attachmentId: z.string().regex(/^att_[A-Za-z0-9_-]{4,64}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ conversationId, attachmentId }, extra) =>
      attempt(bridge, async () => {
        readAttachmentId(attachmentId);
        return downloadToCache(
          bridge,
          await openCache(),
          { conversationId, attachmentId },
          extra.signal,
        );
      }),
  );

  server.registerTool(
    "alibaba_clear_cache",
    {
      title: "Clear attachment cache",
      description: "Delete files in the private local attachment cache. This does not change anything on Alibaba.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const removed = await (await openCache()).clear();
        return { content: [{ type: "text" as const, text: JSON.stringify({ removed }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Attachment cache could not be cleared.";
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: safeAgentError(message) === message ? message : "Attachment cache could not be cleared." }],
        };
      }
    },
  );

  server.registerPrompt(
    "approve-alibaba-send",
    {
      title: "Approve an Alibaba send",
      description: "Show the exact message and require explicit user approval before alibaba_send_message.",
      argsSchema: {
        conversationId: z.string().min(1).max(500),
        text: z.string().min(1).max(10_000),
      },
    },
    ({ conversationId, text }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Ask me whether I approve sending this exact message.",
              "Do not call alibaba_send_message unless I approve this conversation and this text.",
              `Conversation: ${conversationId}`,
              "Message:",
              text,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

async function attempt(bridge: ExtensionBridge, operation: () => Promise<unknown>) {
  try {
    const body = JSON.stringify(await operation(), null, 2) ?? "null";
    return { content: [{ type: "text" as const, text: bridge.sanitize(body) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Alibaba request failed.";
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: bridge.sanitize(message) }],
    };
  }
}

export { ExtensionBridge } from "./bridge.js";
export { BridgeConfigError, isLoopbackAddress, readBridgeConfigFromEnv, tokensMatch } from "./auth.js";
export { AttachmentCache, ageFile, resolveCacheDir } from "./cache.js";
export { downloadToCache } from "./transfer.js";
export { createPairingToken } from "../shared/protocol.js";
