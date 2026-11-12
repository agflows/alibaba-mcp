import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { AlibabaAdapter, allowlistedDownloadUrl, isExtensionBackgroundSender } from "../.test-build/alibaba-adapter.mjs";

function installDom(body, url = "https://message.alibaba.com/message/messenger.htm#/") {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, {
    url,
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "location",
    "MutationObserver",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "InputEvent",
    "Event",
    "Document",
    "Node",
  ]) globalThis[key] = dom.window[key];
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }];
  return dom;
}

function fastAdapter(timeouts = {}) {
  return new AlibabaAdapter({
    timeouts: {
      select: 1_000,
      quiet: 40,
      composer: 400,
      sendEnable: 150,
      sendVerify: 180,
      poll: 10,
      dedupe: 4_000,
      ...timeouts,
    },
  });
}

function messageHost() {
  return (
    document.querySelector(".message-box") ||
    document.querySelector("textarea")?.closest("section, main, form") ||
    document.body
  );
}

function appendOutgoing(text, id, attributes = {}) {
  const node = document.createElement("div");
  node.className = "message-item-wrapper item-right";
  node.dataset.clk = "2020MC_Message_Click";
  node.dataset.expinfo = JSON.stringify({ messageId: id, sendTime: Date.now(), senderId: "me" });
  node.dataset.original = text;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  messageHost().append(node);
  return node;
}

const inbox = `
  <div role="button" data-observer-trigger="contact-item" data-cid="supplier-1-me#icbu"
       data-name="Ada Supplier" data-unread-count="2" data-modify-time="1710000000000"
       class="contact-item-container selected">
    <span class="contact-time">10:21</span>
    <div class="contact-company">Example Manufacturing Ltd.</div>
    <div>Can you share the drawing?</div>
  </div>
  <main class="message-box">
    <div class="message-item-wrapper" data-clk="2020MC_Message_Click"
         data-expinfo='{"messageId":"m1","sendTime":1710000001000,"senderId":"supplier-1"}'
         data-original="Hello &amp; welcome"></div>
    <div class="message-item-wrapper item-right" data-clk="2020MC_Message_Click"
         data-expinfo='{"messageId":"m2","sendTime":1710000002000,"senderId":"me"}'
         data-original="Thanks"></div>
    <div class="message-item-wrapper" data-clk="2020MC_Message_Click"
         data-expinfo='{"messageId":"m3","sendTime":1710000003000,"senderId":"supplier-1"}'
         data-original='&lt;div data-query=&quot;{&amp;quot;fileName&amp;quot;:&amp;quot;spec.pdf&amp;quot;,&amp;quot;fileSize&amp;quot;:&amp;quot;1200&amp;quot;}&quot;&gt;file&lt;/div&gt;'></div>
    <textarea class="send-textarea" placeholder="Please enter your message here"></textarea>
    <button class="send-tool-button">Send</button>
  </main>`;

const threads = `
  <div role="button" data-observer-trigger="contact-item" data-cid="old-thread" data-name="Old Contact"
       class="contact-item-container selected" data-modify-time="1710000000000">
    <div class="contact-company">Old Co</div>
    <div>Previous preview</div>
  </div>
  <div role="button" data-observer-trigger="contact-item" data-cid="felix" data-name="Felix"
       class="contact-item-container" data-modify-time="1710000005000">
    <div class="contact-company">Felix Co</div>
    <div>Felix preview</div>
  </div>
  <div role="button" data-observer-trigger="contact-item" data-cid="cancelled" data-name="Cancelled Account"
       class="contact-item-container" data-modify-time="1710000006000">
    <div class="contact-company">Closed Co</div>
  </div>
  <main class="message-box">
    <div class="message-item-wrapper" data-clk="2020MC_Message_Click"
         data-expinfo='{"messageId":"old-1","sendTime":1710000001000,"senderId":"old"}'
         data-original="OLD MESSAGE"></div>
    <textarea class="send-textarea" placeholder="Please enter your message here"></textarea>
    <button class="send-tool-button">Send</button>
  </main>`;

test.describe("alibaba adapter", { concurrency: 1 }, () => {
  test("lists conversations from stable data attributes", () => {
    installDom(inbox);
    const adapter = new AlibabaAdapter();
    const [conversation] = adapter.listConversations(10, "example");
    assert.equal(conversation.id, "supplier-1-me#icbu");
    assert.equal(conversation.title, "Ada Supplier — Example Manufacturing Ltd.");
    assert.equal(conversation.preview, "Can you share the drawing?");
    assert.equal(conversation.unread, true);
  });

  test("reads message direction, timestamps, and sanitized attachments", async () => {
    installDom(inbox);
    const conversation = await fastAdapter().getConversation("supplier-1-me#icbu", 20);
    assert.deepEqual(
      conversation.messages.map(({ id, sender, text, direction }) => ({ id, sender, text, direction })),
      [
        { id: "m1", sender: "Ada Supplier", text: "Hello & welcome", direction: "incoming" },
        { id: "m2", sender: "You", text: "Thanks", direction: "outgoing" },
        {
          id: "m3",
          sender: "Ada Supplier",
          text: "[Attachment: spec.pdf, 1200 bytes]",
          direction: "incoming",
        },
      ],
    );
  });

  test("reports selector diagnostics instead of silently failing", () => {
    installDom("<p>Signed out</p>");
    const health = new AlibabaAdapter().health();
    assert.equal(health.supportedHost, true);
    assert.equal(health.inboxLoaded, false);
    assert.equal(health.conversationCount, 0);
    assert.equal(health.composerAvailable, false);
    assert.equal(health.sendButtonAvailable, false);
    assert.equal(health.selectorProfile.conversations, undefined);
    assert.equal(health.profileNames.conversations, undefined);
    assert.ok(health.warnings.some((warning) => /logged in|inbox/i.test(warning)));
  });

  test("reports the active profile and a host mismatch", () => {
    installDom(inbox);
    const health = new AlibabaAdapter().health();
    assert.equal(health.profileNames.conversations, "contact-item");
    assert.equal(health.profileNames.messages, "tracked-message");
    assert.equal(health.profileNames.composer, "placeholder-message");
    assert.equal(health.profileNames.sendButton, "send-tool-button");
    assert.equal(health.selectedConversationId, "supplier-1-me#icbu");
    assert.equal(health.sendButtonEnabled, true);
    assert.deepEqual(
      health.warnings.filter((warning) => warning !== "Document is still loading."),
      [],
    );

    installDom(inbox, "https://example.com/messages");
    const foreign = new AlibabaAdapter().health();
    assert.equal(foreign.supportedHost, false);
    assert.ok(foreign.warnings.some((warning) => warning.includes("example.com")));
    assert.throws(() => new AlibabaAdapter().listConversations(5, ""), /not Alibaba Messages/);
  });

  test("reads each fallback conversation, message, and composer profile", async () => {
    const profiles = [
      {
        name: "cid-role-name",
        list: `<div role="button" class="selected" data-cid="role-1" data-name="Rita Role" data-unread-count="0" data-modify-time="1710000000000">
          <span class="contact-time">09:00</span>
          <div class="contact-company">Role Textiles</div>
          <div>Role profile preview</div>
        </div>`,
      },
      {
        name: "contact-container",
        list: `<div class="contact-item-container selected" data-cid="container-1" data-name="Cara Container" data-modify-time="1710000000000">
          <span class="contact-time">09:10</span>
          <div data-company="Container Co</div>
          <div>Container profile preview</div>
        </div>`,
      },
      {
        name: "cid-and-name",
        list: `<article class="selected" data-cid="data-1" data-name="Dana Data" data-ali-id="data-1">
          <time>09:20</time>
          <div>Data profile preview</div>
        </article>`,
      },
    ];

    for (const profile of profiles) {
      installDom(`
        ${profile.list}
        <main class="message-box">
          <article data-message-id="mid-1" data-original="Fallback hello" data-direction="incoming"></article>
          <article data-mid="mid-2" data-original="Fallback reply" data-direction="outgoing"></article>
          <textarea aria-label="Message"></textarea>
          <button type="button" aria-label="Send">Send</button>
        </main>`);
      const adapter = fastAdapter();
      const health = adapter.health();
      assert.equal(health.profileNames.conversations, profile.name, profile.name);
      assert.equal(health.profileNames.messages, "message-id");
      assert.equal(health.profileNames.composer, "labelled-composer");
      assert.equal(health.profileNames.sendButton, "aria-label-send");
      assert.ok(health.warnings.some((warning) => warning.includes(profile.name)));
      const [listed] = adapter.listConversations(10, "");
      const conversation = await adapter.getConversation(listed.id, 10);
      assert.deepEqual(
        conversation.messages.map(({ id, text, direction }) => ({ id, text, direction })),
        [
          { id: "mid-1", text: "Fallback hello", direction: "incoming" },
          { id: "mid-2", text: "Fallback reply", direction: "outgoing" },
        ],
      );
    }
  });

  test("uses a message-box composer when the primary textarea hooks are absent", () => {
    installDom(`
      <div class="contact-item-container selected" data-cid="box-1" data-name="Box Co"></div>
      <main class="message-box">
        <div data-expinfo='{"messageId":"p1","senderId":"them"}' data-original="Ping"></div>
        <textarea></textarea>
        <button type="button" data-action="send">Go</button>
      </main>`);
    const health = new AlibabaAdapter().health();
    assert.equal(health.profileNames.conversations, "contact-container");
    assert.equal(health.profileNames.messages, "expinfo-original");
    assert.equal(health.profileNames.composer, "message-box-textarea");
    assert.equal(health.profileNames.sendButton, "data-action-send");
    assert.equal(health.selectorProfile.sendButton, '[data-action="send"]');
  });

  test("finds the send control by composer ownership, not a fixed parent offset", async () => {
    installDom(`
      <div role="button" data-observer-trigger="contact-item" data-cid="nested-1" data-name="Ann" class="selected contact-item-container"></div>
      <section>
        <div><div><textarea class="send-textarea" placeholder="Please enter your message here"></textarea></div></div>
        <div><button type="button" class="attach-tool-button">Attach</button><button type="button">Send</button></div>
      </section>`);
    const send = document.querySelector("button:last-of-type");
    const attach = document.querySelector(".attach-tool-button");
    let sendClicks = 0;
    let attachClicks = 0;
    send.addEventListener("click", () => {
      sendClicks += 1;
      appendOutgoing("Nested hello", "nested-m1");
    });
    attach.addEventListener("click", () => {
      attachClicks += 1;
    });
    const result = await fastAdapter().sendMessage("nested-1", "Nested hello");
    assert.deepEqual(result, { sent: true, verified: true, messageId: "nested-m1" });
    assert.equal(sendClicks, 1);
    assert.equal(attachClicks, 0);
  });

  test("verifies a newly sent message and does not click twice for the same text", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      appendOutgoing(textarea.value, "m-new");
    });
    const adapter = fastAdapter();
    const first = await adapter.sendMessage("supplier-1-me#icbu", "Ship it");
    const second = await adapter.sendMessage("supplier-1-me#icbu", "Ship it");
    assert.equal(clicks, 1);
    assert.deepEqual(first, { sent: true, verified: true, messageId: "m-new" });
    assert.deepEqual(second, { sent: true, verified: true, messageId: "m-new", deduped: true });
    assert.equal(textarea.value, "");
    assert.equal(adapter.health().lastSend.outcome, "verified");
    assert.equal(adapter.health().lastSend.messageId, "m-new");
  });

  test("does not treat an existing outgoing copy or a new incoming copy as confirmation", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    const adapter = fastAdapter({ sendVerify: 120 });
    await assert.rejects(
      () => adapter.sendMessage("supplier-1-me#icbu", "Thanks"),
      /safe to retry/,
    );
    assert.equal(clicks, 1);
    assert.equal(textarea.value, "Thanks");

    button.addEventListener("click", () => {
      textarea.value = "";
      const incoming = document.createElement("div");
      incoming.className = "message-item-wrapper";
      incoming.dataset.clk = "2020MC_Message_Click";
      incoming.dataset.expinfo = JSON.stringify({ messageId: "m-in", sendTime: Date.now(), senderId: "supplier-1" });
      incoming.dataset.original = "Different text";
      document.querySelector(".message-box").append(incoming);
    });
    await assert.rejects(
      () => adapter.sendMessage("supplier-1-me#icbu", "Different text"),
      /Do not retry yet/,
    );
    assert.equal(adapter.health().lastSend.outcome, "ambiguous");
  });

  test("recovers an unconfirmed send from the transcript without clicking again", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
      textarea.value = "";
    });
    const adapter = fastAdapter({ sendVerify: 120 });
    await assert.rejects(() => adapter.sendMessage("supplier-1-me#icbu", "Ship it"), /Do not retry yet/);
    appendOutgoing("Ship it", "m-late");
    const recovered = await adapter.sendMessage("supplier-1-me#icbu", "Ship it");
    assert.equal(clicks, 1);
    assert.deepEqual(recovered, { sent: true, verified: true, messageId: "m-late", deduped: true });
  });

  test("does not click a disabled send control and clears the unsent draft", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    button.classList.add("gray");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    await assert.rejects(
      () => fastAdapter({ sendEnable: 80 }).sendMessage("supplier-1-me#icbu", "Hi"),
      /did not enable the Send control/,
    );
    assert.equal(clicks, 0);
    assert.equal(textarea.value, "");
  });

  test("serializes overlapping sends so each click carries its own text", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    const clicks = [];
    button.addEventListener("click", () => {
      clicks.push(textarea.value);
      appendOutgoing(textarea.value, `id-${clicks.length}`);
    });
    const adapter = fastAdapter();
    const [first, second] = await Promise.all([
      adapter.sendMessage("supplier-1-me#icbu", "One"),
      adapter.sendMessage("supplier-1-me#icbu", "Two"),
    ]);
    assert.deepEqual(clicks, ["One", "Two"]);
    assert.equal(first.messageId, "id-1");
    assert.equal(second.messageId, "id-2");
    assert.equal(second.deduped, undefined);
  });

  test("skips the send click when the draft is already echoed as a new outgoing message", async () => {
    installDom(inbox);
    const button = document.querySelector("button.send-tool-button");
    const textarea = document.querySelector("textarea");
    let clicks = 0;
    textarea.addEventListener("input", () => {
      if (!textarea.value) return;
      appendOutgoing(textarea.value, "m-echo");
    });
    button.addEventListener("click", () => {
      clicks += 1;
    });
    const result = await fastAdapter().sendMessage("supplier-1-me#icbu", "Echo");
    assert.equal(clicks, 0);
    assert.equal(result.messageId, "m-echo");
    assert.equal(result.verified, true);
  });

  test("treats a selected conversation with no rendered messages as empty", async () => {
    installDom(`
      <div role="button" data-observer-trigger="contact-item" data-cid="cancelled" data-name="Cancelled Account"
           class="contact-item-container selected" data-modify-time="1710000000000">
        <div class="contact-company">Closed Co</div>
      </div>
      <main class="message-box">
        <textarea class="send-textarea" placeholder="Please enter your message here"></textarea>
        <button class="send-tool-button">Send</button>
      </main>`);
    const conversation = await fastAdapter().getConversation("cancelled", 20);
    assert.equal(conversation.title, "Cancelled Account — Closed Co");
    assert.deepEqual(conversation.messages, []);
  });

  test("waits out a selection race and reads the conversation that opened", async () => {
    installDom(threads);
    const felix = document.querySelector('[data-cid="felix"]');
    const old = document.querySelector('[data-cid="old-thread"]');
    let timer;
    felix.addEventListener("click", () => {
      felix.classList.add("selected");
      old.classList.remove("selected");
      let count = 0;
      timer = setInterval(() => {
        count += 1;
        if (count === 1) document.querySelector('[data-original="OLD MESSAGE"]')?.remove();
        const node = appendOutgoing(`Felix message ${count}`, `felix-${count}`);
        node.dataset.direction = "incoming";
        node.classList.remove("item-right");
        if (count === 6) clearInterval(timer);
      }, 20);
    });
    let conversation;
    try {
      conversation = await fastAdapter({ quiet: 80, select: 2_000 }).getConversation("felix", 20);
    } finally {
      clearInterval(timer);
    }
    assert.equal(conversation.messages.length, 6);
    assert.deepEqual(
      conversation.messages.map((message) => message.text),
      ["Felix message 1", "Felix message 2", "Felix message 3", "Felix message 4", "Felix message 5", "Felix message 6"],
    );
    assert.ok(conversation.messages.every((message) => message.sender === "Felix"));
  });

  test("returns an empty thread after switching away from another conversation", async () => {
    installDom(threads);
    const cancelled = document.querySelector('[data-cid="cancelled"]');
    const old = document.querySelector('[data-cid="old-thread"]');
    cancelled.addEventListener("click", () => {
      setTimeout(() => {
        cancelled.classList.add("selected");
        old.classList.remove("selected");
        document.querySelector('[data-original="OLD MESSAGE"]')?.remove();
      }, 30);
    });
    const conversation = await fastAdapter().getConversation("cancelled", 20);
    assert.equal(conversation.id, "cancelled");
    assert.deepEqual(conversation.messages, []);
  });

  test("does not return the previously open thread when its messages stay on screen", async () => {
    installDom(threads);
    const felix = document.querySelector('[data-cid="felix"]');
    felix.addEventListener("click", () => {
      felix.classList.add("selected");
    });
    await assert.rejects(
      () => fastAdapter({ select: 250, quiet: 30 }).getConversation("felix", 20),
      /previously open thread/,
    );
  });

  test("parses messages without executing markup or throwing on bad metadata", async () => {
    installDom(inbox);
    const box = document.querySelector(".message-box");
    const hostile = document.createElement("div");
    hostile.className = "message-item-wrapper";
    hostile.dataset.clk = "2020MC_Message_Click";
    hostile.dataset.expinfo = "not-json";
    hostile.dataset.original = '<script>globalThis.__xss=1</script><img src="x" onerror="globalThis.__xss=2"><p>Hello <b>there</b></p>';
    const encoded = document.createElement("div");
    encoded.className = "message-item-wrapper";
    encoded.dataset.clk = "2020MC_Message_Click";
    encoded.dataset.expinfo = "[]";
    encoded.dataset.original = "Plain line";
    const file = document.createElement("div");
    file.className = "message-item-wrapper";
    file.dataset.clk = "2020MC_Message_Click";
    file.dataset.expinfo = JSON.stringify({ messageId: "file-1", sendTime: 1710000004000, senderId: "supplier-1" });
    const holder = document.createElement("div");
    const inner = document.createElement("div");
    inner.dataset.query = JSON.stringify({ fileName: "spec<script>.pdf", fileSize: "10" });
    inner.textContent = "file";
    holder.append(inner);
    file.dataset.original = holder.innerHTML;
    const scriptOnly = document.createElement("div");
    scriptOnly.className = "message-item-wrapper";
    scriptOnly.dataset.clk = "2020MC_Message_Click";
    scriptOnly.dataset.expinfo = JSON.stringify({ messageId: "script-1", senderId: "supplier-1" });
    scriptOnly.dataset.original = "<script>globalThis.__xss=3</script>";
    box.prepend(hostile);
    box.append(encoded, file, scriptOnly);
    delete globalThis.__xss;

    const conversation = await fastAdapter().getConversation("supplier-1-me#icbu", 20);
    assert.equal(globalThis.__xss, undefined);
    const hostileMessage = conversation.messages.find((message) => message.text === "Hello there");
    assert.ok(hostileMessage);
    assert.equal(hostileMessage.direction, "incoming");
    assert.equal(hostileMessage.text.includes("<"), false);
    assert.ok(conversation.messages.some((message) => message.text === "Plain line" && message.id.startsWith("visible-")));
    assert.ok(conversation.messages.some((message) => message.text === "[Attachment: spec.pdf, 10 bytes]"));
    assert.equal(conversation.messages.some((message) => message.id === "script-1"), false);
  });

  test("uses the page self id when a message has no outgoing class", async () => {
    installDom(`
      <div role="button" data-observer-trigger="contact-item" data-cid="self-1" data-name="Sam" class="selected contact-item-container"></div>
      <main class="message-box">
        <div data-expinfo='{"messageId":"a","senderId":"me","sendTime":1710000001000}' data-original="Mine"></div>
        <div data-expinfo='{"messageId":"b","senderId":"them","sendTime":1710000002000}' data-original="Theirs"></div>
        <textarea class="send-textarea" placeholder="Please enter your message here"></textarea>
      </main>`);
    document.body.dataset.selfId = "me";
    const conversation = await fastAdapter().getConversation("self-1", 10);
    assert.deepEqual(
      conversation.messages.map(({ text, direction }) => ({ text, direction })),
      [
        { text: "Mine", direction: "outgoing" },
        { text: "Theirs", direction: "incoming" },
      ],
    );
  });

  test("lists attachment metadata without download urls, cookies, or signed links", async () => {
    installDom(inbox);
    const secret = "https://clouddisk.alibaba.com/file/download.htm?fileId=abc&token=supersecret";
    const message = document.querySelector('[data-original="Thanks"]').nextElementSibling;
    const holder = document.createElement("div");
    const card = document.createElement("div");
    card.dataset.query = JSON.stringify({
      fileName: "spec.pdf",
      fileSize: "1200",
      fileType: "application/pdf",
      cookie: "session=secret",
      downloadUrl: secret,
      fileId: "file_123",
    });
    holder.append(card);
    message.dataset.original = holder.innerHTML;
    const other = document.createElement("div");
    other.className = "message-item-wrapper";
    other.dataset.clk = "2020MC_Message_Click";
    other.dataset.cid = "someone-else";
    other.dataset.expinfo = JSON.stringify({ messageId: "other-1", senderId: "supplier-1" });
    other.dataset.original = `<div data-query='${JSON.stringify({
      fileName: "other.pdf",
      downloadUrl: "https://clouddisk.alibaba.com/other?token=othersecret",
    })}'></div>`;
    message.parentElement.append(other);

    const adapter = fastAdapter();
    const listed = await adapter.listAttachments("supplier-1-me#icbu");
    const serialized = JSON.stringify(listed);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].messageId, "m3");
    assert.equal(listed[0].name, "spec.pdf");
    assert.equal(listed[0].sizeBytes, 1200);
    assert.equal(listed[0].type, "application/pdf");
    assert.match(listed[0].id, /^att_[A-Za-z0-9_-]+$/);
    assert.equal(serialized.includes("clouddisk"), false);
    assert.equal(serialized.includes("supersecret"), false);
    assert.equal(serialized.includes("cookie"), false);
    assert.equal(serialized.includes("http"), false);
    assert.equal(serialized.includes("other.pdf"), false);
    assert.equal(Object.hasOwn(listed[0], "downloadUrl"), false);

    const conversation = await adapter.getConversation("supplier-1-me#icbu", 20);
    const read = JSON.stringify(conversation);
    assert.equal(read.includes("supersecret"), false);
    assert.equal(read.includes("clouddisk"), false);
    assert.ok(conversation.messages.some((item) => item.text === "[Attachment: spec.pdf, 1200 bytes]"));

    const prepared = await adapter.prepareAttachment("supplier-1-me#icbu", listed[0].id);
    assert.equal(prepared.downloadUrl, secret);
    await assert.rejects(
      () => adapter.prepareAttachment("supplier-1-me#icbu", "att_missing_00000000"),
      /not in the selected conversation/,
    );
  });

  test("keeps a file when data-query is malformed and rejects non-clouddisk urls", async () => {
    installDom(`
      <div role="button" data-observer-trigger="contact-item" data-cid="files-1" data-name="Files" class="selected contact-item-container"></div>
      <main class="message-box">
        <div class="message-item-wrapper" data-clk="2020MC_Message_Click"
             data-expinfo='{"messageId":"bad-1","senderId":"them"}' data-original="notes"></div>
        <textarea class="send-textarea" placeholder="Please enter your message here"></textarea>
        <button class="send-tool-button">Send</button>
      </main>`);
    const message = document.querySelector('[data-expinfo*="bad-1"]');
    const card = document.createElement("div");
    card.dataset.query = "{not-json";
    card.dataset.fileName = "notes<script>.txt";
    card.dataset.fileSize = "15";
    card.dataset.fileType = "text/plain";
    card.dataset.downloadUrl = "http://clouddisk.alibaba.com/notes.txt";
    message.append(card);
    const evil = document.createElement("div");
    evil.className = "message-item-wrapper";
    evil.dataset.clk = "2020MC_Message_Click";
    evil.dataset.expinfo = JSON.stringify({ messageId: "bad-2", senderId: "them" });
    evil.dataset.original = "picture";
    evil.dataset.fileName = "picture.png";
    evil.dataset.downloadUrl = "https://clouddisk.alibaba.com.evil.com/picture.png?token=nope";
    message.parentElement.append(evil);

    const adapter = fastAdapter();
    const listed = await adapter.listAttachments("files-1");
    assert.deepEqual(
      listed.map(({ name, sizeBytes, type }) => ({ name, sizeBytes, type })),
      [
        { name: "notes.txt", sizeBytes: 15, type: "text/plain" },
        { name: "picture.png", sizeBytes: undefined, type: "png" },
      ],
    );
    assert.equal(JSON.stringify(listed).includes("token"), false);
    await assert.rejects(
      () => adapter.prepareAttachment("files-1", listed[0].id),
      /no Alibaba clouddisk download URL/,
    );
    await assert.rejects(
      () => adapter.prepareAttachment("files-1", listed[1].id),
      /no Alibaba clouddisk download URL/,
    );
    const conversation = await adapter.getConversation("files-1", 10);
    assert.equal(JSON.stringify(conversation).includes("nope"), false);
  });

  test("allowlists only https alibaba clouddisk urls and the extension background", () => {
    const accepted = allowlistedDownloadUrl("https://clouddisk.alibaba.com/file/download.htm?fileId=abc&token=secret");
    assert.equal(accepted, "https://clouddisk.alibaba.com/file/download.htm?fileId=abc&token=secret");
    assert.equal(allowlistedDownloadUrl("https://img.clouddisk.alibaba.com/path/a.pdf"), "https://img.clouddisk.alibaba.com/path/a.pdf");
    for (const rejected of [
      "http://clouddisk.alibaba.com/file",
      "https://user:pass@clouddisk.alibaba.com/file",
      "https://clouddisk.alibaba.com.evil.com/file",
      "https://evilclouddisk.alibaba.com/file",
      "https://files.example.com/clouddisk.alibaba.com/file?token=secret",
      "https://message.alibaba.com/file",
      "javascript:https://clouddisk.alibaba.com/file",
      "https://clouddisk.alibaba.com:8443/file",
      "not a url",
      "",
    ]) {
      assert.equal(allowlistedDownloadUrl(rejected), null, rejected);
    }

    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const background = { id: extensionId, url: `chrome-extension://${extensionId}/background.js` };
    assert.equal(isExtensionBackgroundSender(background, extensionId), true);
    assert.equal(isExtensionBackgroundSender({ ...background, tab: { id: 1 } }, extensionId), false);
    assert.equal(
      isExtensionBackgroundSender({ id: extensionId, url: `chrome-extension://${extensionId}/popup.html` }, extensionId),
      false,
    );
    assert.equal(
      isExtensionBackgroundSender({ id: "other", url: `chrome-extension://${extensionId}/background.js` }, extensionId),
      false,
    );
    assert.equal(isExtensionBackgroundSender({ id: extensionId }, extensionId), false);
    assert.equal(
      isExtensionBackgroundSender({ id: extensionId, url: "https://clouddisk.alibaba.com/background.js" }, extensionId),
      false,
    );
  });

  test("rejects an unknown conversation without reading another thread", async () => {
    installDom(inbox);
    await assert.rejects(
      () => fastAdapter().getConversation("missing-conversation", 10),
      /not currently loaded/,
    );
  });
});
