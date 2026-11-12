import {
  ATTACHMENT_FAILED,
  MAX_ATTACHMENT_BYTES,
  type PublicAttachment,
} from "../shared/attachments.js";
import { AttachmentCache, type CacheWrite } from "./cache.js";
import { ExtensionBridge } from "./bridge.js";

export interface SavedAttachment {
  path: string;
  name: string;
  byteSize: number;
  sha256: string;
  contentType?: string;
}

export async function downloadToCache(
  bridge: ExtensionBridge,
  cache: AttachmentCache,
  params: { conversationId: string; attachmentId: string },
  signal?: AbortSignal,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<SavedAttachment> {
  let write: CacheWrite | undefined;
  let contentType: string | undefined;
  let saved: SavedAttachment | undefined;
  let closed = false;
  const pending = new Set<Promise<void>>();
  const track = (operation: Promise<void>) => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
    return operation;
  };
  try {
    await bridge.download(
      params,
      {
        start(meta) {
          return track((async () => {
            contentType = meta.contentType;
            const next = await cache.begin(meta.name, maxBytes);
            if (closed) {
              await next.abort();
              return;
            }
            write = next;
          })());
        },
        chunk(_offset, data) {
          return track((async () => {
            if (!write || closed) throw new Error(ATTACHMENT_FAILED);
            await write.write(data);
          })());
        },
        end() {
          return track((async () => {
            if (!write || closed) throw new Error(ATTACHMENT_FAILED);
            const finished = await write.finish();
            saved = {
              path: finished.path,
              name: finished.name,
              byteSize: finished.byteSize,
              sha256: finished.sha256,
              ...(contentType ? { contentType } : {}),
            };
          })());
        },
      },
      { signal, maxBytes },
    );
    if (!saved) throw new Error(ATTACHMENT_FAILED);
    return saved;
  } catch (error) {
    closed = true;
    await Promise.allSettled([...pending]);
    await write?.abort();
    throw error;
  }
}

export type { PublicAttachment };
