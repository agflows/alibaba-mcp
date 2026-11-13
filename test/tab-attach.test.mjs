import test from "node:test";
import assert from "node:assert/strict";
import { messengerScriptMissing, messengerTabUnloaded } from "../.test-build/tab-attach.mjs";

test("a background tab with its address still showing is treated as unloaded", () => {
  assert.equal(messengerTabUnloaded({ discarded: true, status: "unloaded" }), true);
  assert.equal(messengerTabUnloaded({ status: "unloaded" }), true);
  assert.equal(messengerTabUnloaded({ discarded: false, status: "complete" }), false);
  assert.equal(messengerTabUnloaded({ status: "loading" }), false);
});

test("a missing page script is recognized from Chrome's connection error", () => {
  assert.equal(messengerScriptMissing(new Error("Could not establish connection. Receiving end does not exist.")), true);
  assert.equal(messengerScriptMissing(new Error("The tab was discarded.")), true);
  assert.equal(messengerScriptMissing(new Error("Alibaba did not confirm the sent message.")), false);
});
