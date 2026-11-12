import test from "node:test";
import assert from "node:assert/strict";
import {
  SEND_APPROVAL_INSTRUCTION,
  accessError,
  canRead,
  canWrite,
  createPairingToken,
  formatAgentSetup,
  isExactExtensionOrigin,
  isExtensionUiSender,
  isValidExtensionId,
  isValidPairingToken,
  normalizeAccessMode,
  parseIncomingCommand,
  safePageUrl,
} from "../.test-build/protocol.mjs";
import { nextReconnectDelay, socketNeedsReconnect } from "../.test-build/reconnect.mjs";

const extensionId = "a".repeat(32);

test("access levels are exclusive and write is read plus send", () => {
  assert.equal(canRead("none"), false);
  assert.equal(canWrite("none"), false);
  assert.equal(canRead("read"), true);
  assert.equal(canWrite("read"), false);
  assert.equal(canRead("write"), true);
  assert.equal(canWrite("write"), true);
  assert.equal(normalizeAccessMode("write"), "write");
  assert.equal(normalizeAccessMode("read"), "read");
  assert.equal(normalizeAccessMode("none"), "none");
  assert.equal(normalizeAccessMode("admin"), null);
  assert.equal(normalizeAccessMode(undefined), null);

  assert.equal(accessError("none", "get_status"), null);
  assert.match(accessError("none", "list_conversations") ?? "", /disabled/i);
  assert.match(accessError("none", "list_attachments") ?? "", /disabled/i);
  assert.match(accessError("none", "download_attachment") ?? "", /disabled/i);
  assert.equal(accessError("read", "download_attachment"), null);
  assert.equal(accessError("read", "list_attachments"), null);
  assert.match(accessError("read", "send_message") ?? "", /Read & write/);
  assert.equal(accessError("write", "send_message"), null);
  assert.equal(accessError("write", "get_conversation"), null);
  assert.match(accessError("write", "delete_account") ?? "", /Unsupported/);
});

test("pairing tokens are high entropy and setup text requires approval", () => {
  const first = createPairingToken();
  const second = createPairingToken();
  assert.notEqual(first, second);
  assert.equal(isValidPairingToken(first), true);
  assert.equal(isValidPairingToken("short"), false);
  assert.equal(isValidPairingToken("a".repeat(31)), false);
  assert.equal(isValidPairingToken(`${"a".repeat(32)}+` ), false);
  assert.equal(isValidExtensionId(extensionId), true);
  assert.equal(isValidExtensionId("q".repeat(32)), false);
  assert.equal(isValidExtensionId(extensionId.toUpperCase()), false);

  const setup = formatAgentSetup({ token: first, extensionId });
  assert.match(setup, /explicit approval/);
  assert.match(setup, /dist\/server\/index\.js/);
  assert.ok(setup.includes(first));
  assert.ok(setup.includes(extensionId));
  assert.equal(setup.includes(SEND_APPROVAL_INSTRUCTION), true);
  assert.match(setup, /Do not ask for or display Alibaba download URLs/);
  assert.doesNotMatch(setup, /cookie/i);
});

test("page urls keep the path and drop the query", () => {
  assert.equal(
    safePageUrl("https://message.alibaba.com/message/messenger.htm?spm=secret#/inbox"),
    "https://message.alibaba.com/message/messenger.htm",
  );
  assert.equal(safePageUrl("https://example.com/message"), null);
  assert.equal(safePageUrl("http://message.alibaba.com/message"), null);
  assert.equal(safePageUrl("not a url"), null);
});

test("bridge commands and extension ui senders are narrow", () => {
  assert.deepEqual(parseIncomingCommand({ id: "1", method: "get_status", params: { limit: 1 } }), {
    id: "1",
    method: "get_status",
    params: { limit: 1 },
  });
  assert.equal(parseIncomingCommand({ id: "1", method: "get_status" }).params !== null, true);
  assert.equal(parseIncomingCommand({ type: "pong" }), null);
  assert.equal(parseIncomingCommand({ id: "", method: "get_status" }), null);
  assert.equal(parseIncomingCommand({ id: "1", method: "get_status", params: [] }), null);

  const popup = `chrome-extension://${extensionId}/popup.html`;
  assert.equal(isExtensionUiSender({ id: extensionId, url: popup }, extensionId), true);
  assert.equal(
    isExtensionUiSender({ id: extensionId, url: "https://message.alibaba.com/message/messenger.htm" }, extensionId),
    false,
  );
  assert.equal(isExtensionUiSender({ id: "b".repeat(32), url: popup }, extensionId), false);
  assert.equal(isExactExtensionOrigin(`chrome-extension://${extensionId}`, extensionId), true);
  assert.equal(isExactExtensionOrigin(`chrome-extension://${extensionId}/`, extensionId), false);
  assert.equal(isExactExtensionOrigin("https://message.alibaba.com", extensionId), false);
  assert.equal(isExactExtensionOrigin(undefined, extensionId), false);
});

test("reconnect delay stays bounded", () => {
  assert.equal(nextReconnectDelay(1000), 1700);
  assert.equal(nextReconnectDelay(14_000), 15_000);
  assert.equal(nextReconnectDelay(Number.NaN), 1000);
  assert.equal(socketNeedsReconnect(null), true);
  assert.equal(socketNeedsReconnect(0), false);
  assert.equal(socketNeedsReconnect(1), false);
  assert.equal(socketNeedsReconnect(3), true);
});
