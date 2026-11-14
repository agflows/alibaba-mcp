import test from "node:test";
import assert from "node:assert/strict";
import { SendApprovalGate } from "../.test-build/send-approval.mjs";

const details = {
  conversationId: "conversation-1",
  conversationTitle: "Supplier A",
  text: "Exact message\nwith a second line.",
};

test("send approval preserves the exact request and resolves an explicit decision once", async () => {
  const gate = new SendApprovalGate(1_000, () => "approval-1");
  const pending = gate.begin(details);
  assert.deepEqual(gate.snapshot(), { id: "approval-1", ...details });
  assert.equal(gate.decide("wrong", true), false);
  assert.equal(gate.decide("approval-1", true), true);
  assert.equal(await pending.decision, true);
  assert.equal(gate.snapshot(), null);
  assert.equal(gate.decide("approval-1", true), false);
});

test("send approval rejects concurrent requests and cancellation fails closed", async () => {
  const gate = new SendApprovalGate(1_000, () => "approval-2");
  const pending = gate.begin(details);
  assert.throws(() => gate.begin(details), /Another Alibaba send/);
  assert.equal(gate.cancel(), true);
  assert.equal(await pending.decision, false);
  assert.equal(gate.cancel(), false);
});

test("send approval times out as a decline", async () => {
  const gate = new SendApprovalGate(10, () => "approval-3");
  const pending = gate.begin(details);
  assert.equal(await pending.decision, false);
  assert.equal(gate.snapshot(), null);
});
