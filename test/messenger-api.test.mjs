import test from "node:test";
import assert from "node:assert/strict";
import { createMessenger, messengerSendPayload, MESSENGER_CSRF_URL, MESSENGER_HISTORY_URL } from "../.test-build/messenger-api.mjs";

const CID = "2500001486209-5500029568478#11011@icbu";
const TOKEN = "csrf-token-value-1234567890";

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function csrf() {
  return json({ token: TOKEN });
}

function history(messages, extra = {}) {
  return json({
    code: "200",
    data: {
      messageList: messages,
      hasMore: extra.hasMore ?? false,
      nextPointTimeStamp: extra.next ?? null,
    },
  });
}

function messengerFor(options = {}) {
  const calls = [];
  const sent = [];
  const queue = [...(options.responses ?? [])];
  const messenger = createMessenger({
    async fetchImpl(url, init) {
      calls.push({ url, body: init.body ?? "" });
      const next = queue.shift() ?? options.repeat;
      if (!next) throw new Error(`Unexpected fetch ${url}`);
      return next;
    },
    now: () => options.now ?? 1_700_000_000_000,
    sleep: async () => {},
    conversationRecords: () => options.records ?? [],
    canSend: () => options.canSend !== false,
    sendText(cid, content) {
      sent.push({ cid, content });
      if (options.sendError) throw options.sendError;
      if (options.sendReject) return Promise.reject(options.sendReject);
      return { accepted: true };
    },
  });
  return { messenger, calls, sent };
}

const records = [
  {
    cid: "111-222#11011@icbu",
    name: "Older",
    companyName: "Old Co",
    unreadCount: 0,
    lastContactTime: 1_000,
    visible: true,
    lastMsg: { content: "old note" },
  },
  {
    cid: "2500001486209-5500029568478#11011",
    name: "Ryan",
    companyName: "Changsha Qianshixian Technology Co., Ltd.",
    unreadCount: "2",
    lastContactTime: 3_000,
    visible: true,
    lastMsg: { content: "see https://clouddisk.alibaba.com/file?token=secret-value" },
  },
  {
    cid: "hidden-1#11011@icbu",
    name: "Hidden",
    companyName: "Nope",
    lastContactTime: 9_000,
    visible: false,
  },
];

test("lists the in-page conversation catalog without chat tokens", () => {
  const { messenger, calls } = messengerFor({ records });
  const listed = messenger.listConversations(10, "qian");
  assert.equal(calls.length, 0);
  assert.deepEqual(listed, [
    {
      id: CID,
      title: "Ryan — Changsha Qianshixian Technology Co., Ltd.",
      preview: "see [attachment]",
      unread: true,
      timestamp: new Date(3_000).toISOString(),
    },
  ]);
  assert.equal(JSON.stringify(listed).includes("secret-value"), false);
  assert.equal(JSON.stringify(messenger.listConversations(10, "")).includes("Hidden"), false);
  assert.equal(messenger.listConversations(1, "")[0].id, CID);
});

test("reads history by conversation id, oldest first, without switching chats or leaking urls", async () => {
  const { messenger, calls } = messengerFor({
    records,
    responses: [
      csrf(),
      history(
        [
          {
            messageId: "m2",
            content: "Thanks",
            sendTime: 2_000,
            messageType: 1,
            messageSendType: "send",
          },
          {
            messageId: "m3",
            content: JSON.stringify({
              fileName: "spec.pdf",
              fileSize: 1200,
              url: "https://clouddisk.alibaba.com/x?token=secret-value",
            }),
            sendTime: 3_000,
            messageType: 53,
            messageSendType: "rec",
          },
        ],
        { hasMore: true, next: 1_000 },
      ),
      history(
        [
          {
            messageId: "m1",
            content: "Hello &amp; welcome",
            sendTime: 1_000,
            messageType: 1,
            messageSendType: "rec",
          },
        ],
        { hasMore: false },
      ),
    ],
  });

  const conversation = await messenger.getConversation("2500001486209-5500029568478#11011", 20);
  assert.equal(conversation.id, CID);
  assert.equal(conversation.title, "Ryan — Changsha Qianshixian Technology Co., Ltd.");
  assert.deepEqual(
    conversation.messages.map(({ id, sender, text, direction }) => ({ id, sender, text, direction })),
    [
      { id: "m1", sender: "Ryan", text: "Hello & welcome", direction: "incoming" },
      { id: "m2", sender: "You", text: "Thanks", direction: "outgoing" },
      { id: "m3", sender: "Ryan", text: "[Attachment: spec.pdf, 1200 bytes]", direction: "incoming" },
    ],
  );
  assert.deepEqual(calls.map((call) => call.url), [MESSENGER_CSRF_URL, MESSENGER_HISTORY_URL, MESSENGER_HISTORY_URL]);
  const params = new URLSearchParams(calls[1].body);
  assert.equal(JSON.parse(params.get("params")).conversationId, CID);
  assert.equal(params.get("_csrf"), TOKEN);
  assert.equal(JSON.stringify(conversation).includes("secret-value"), false);
  assert.equal(JSON.stringify(conversation).includes("clouddisk"), false);
});

test("sends through the page message service and confirms the new outgoing message", async () => {
  const { messenger, calls, sent } = messengerFor({
    records,
    responses: [
      csrf(),
      history([]),
      csrf(),
      history([
        {
          messageId: "sent-1",
          content: "Hello there",
          sendTime: 4_000,
          messageType: 1,
          messageSendType: "send",
        },
      ]),
    ],
  });

  const result = await messenger.sendMessage(CID, "Hello there");
  assert.deepEqual(sent, [{ cid: CID, content: "Hello there" }]);
  assert.deepEqual(result, { sent: true, verified: true, messageId: "sent-1" });
  assert.deepEqual(calls.map((call) => call.url), [
    MESSENGER_CSRF_URL,
    MESSENGER_HISTORY_URL,
    MESSENGER_CSRF_URL,
    MESSENGER_HISTORY_URL,
  ]);

  const again = await messenger.sendMessage(CID, "Hello there");
  assert.equal(sent.length, 1);
  assert.equal(again.deduped, true);
  assert.equal(again.messageId, "sent-1");
});

test("does not send when the message service or history check is unavailable", async () => {
  const missing = messengerFor({ canSend: false, records });
  await assert.rejects(() => missing.messenger.sendMessage(CID, "Hello"), /not loaded/);
  assert.equal(missing.sent.length, 0);
  assert.equal(missing.calls.length, 0);

  const rejected = messengerFor({
    records,
    sendError: new Error("boom"),
    responses: [csrf(), history([]), csrf(), history([])],
  });
  await assert.rejects(() => rejected.messenger.sendMessage(CID, "Hello"), /safe to retry/);
  assert.equal(rejected.sent.length, 1);

  const blind = messengerFor({
    records,
    responses: [json({ token: TOKEN }, 503)],
  });
  await assert.rejects(() => blind.messenger.sendMessage(CID, "Hello"), /HTTP 503/);
  assert.equal(blind.sent.length, 0);
  await assert.rejects(() => blind.messenger.getConversation("not a conversation", 5), /not in Alibaba/);
});

test("builds the web client's conversation-scoped send payload", () => {
  const payload = messengerSendPayload("2500001486209-5500029568478#11011", "Hello there", [
    { cid: CID, aliId: 2500001486209, chatToken: "chat-token-value" },
  ]);
  assert.deepEqual(payload, {
    cid: CID,
    content: "Hello there",
    msgType: 1,
    aliId: 2500001486209,
    chatToken: "chat-token-value",
    ext: { chatScene: JSON.stringify({ clientInfo: "web" }) },
  });
  assert.deepEqual(messengerSendPayload(CID, "Hello there", []), {
    cid: CID,
    content: "Hello there",
    msgType: 1,
    ext: { chatScene: JSON.stringify({ clientInfo: "web" }) },
  });
});

test("treats a rejected send as safe to retry and an unconfirmed send as not", async () => {
  const rejected = messengerFor({
    records,
    sendReject: new Error("nope"),
    responses: [csrf(), history([]), csrf(), history([])],
  });
  await assert.rejects(() => rejected.messenger.sendMessage(CID, "Hello"), /safe to retry/);

  const unconfirmed = messengerFor({
    records,
    responses: [csrf(), history([]), csrf(), history([])],
  });
  await assert.rejects(() => unconfirmed.messenger.sendMessage(CID, "Hello"), /Do not retry yet/);
});

test("reports messenger readiness from the page globals", () => {
  const ready = messengerFor({ records, canSend: true });
  assert.deepEqual(ready.messenger.status(), { conversationCount: 3, messageServiceReady: true });
  const empty = messengerFor({ records: [], canSend: false });
  assert.deepEqual(empty.messenger.status(), { conversationCount: 0, messageServiceReady: false });
  assert.throws(() => empty.messenger.listConversations(10, ""), /not loaded/);
});
