import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_STAFF_CALL_COOLDOWN_MS,
  customerStaffCallCooldownKey,
  customerStaffCallCooldownSeconds,
  isCustomerStaffCallSuccessNotice,
  isMatchingCustomerStaffCallResolution,
  parseCustomerStaffCallCooldown,
} from "../src/customer-staff-call.js";

test("staff-call cooldown is scoped to device and visit and survives a reload", () => {
  const record = { staffCallId: "call-current", visitContextId: "visit-a", untilAtMs: 30_000 };
  const saved = JSON.stringify(record);
  assert.equal(parseCustomerStaffCallCooldown(saved, 10_000)?.staffCallId, "call-current");
  assert.equal(parseCustomerStaffCallCooldown(saved, 30_000), null);
  assert.equal(customerStaffCallCooldownSeconds(record, 0), 30);
  assert.equal(customerStaffCallCooldownSeconds(record, 1_500), 29);
  assert.equal(customerStaffCallCooldownSeconds(record, 30_000), 0);
  assert.equal(CUSTOMER_STAFF_CALL_COOLDOWN_MS, 30_000);
  assert.notEqual(customerStaffCallCooldownKey("device-a", "visit-a"), customerStaffCallCooldownKey("device-a", "visit-b"));
  assert.notEqual(customerStaffCallCooldownKey("device-a", "visit-a"), customerStaffCallCooldownKey("device-b", "visit-a"));
});

test("only the current visit's exact call resolution matches", () => {
  const current = { type: "staff_call.resolved", aggregateId: "call-current", payload: { resource: "staffCalls" } };
  assert.equal(isMatchingCustomerStaffCallResolution(current, { staffCallId: "call-current", visitContextId: "visit-a" }), true);
  assert.equal(isMatchingCustomerStaffCallResolution({ ...current, aggregateId: "call-other" }, { staffCallId: "call-current", visitContextId: "visit-a" }), false);
  assert.equal(isMatchingCustomerStaffCallResolution({ ...current, payload: { resource: "staffCalls", visitContextId: "visit-b" } }, { staffCallId: "call-current", visitContextId: "visit-a" }), false);
  assert.equal(isMatchingCustomerStaffCallResolution({ ...current, type: "staff_call.created" }, { staffCallId: "call-current", visitContextId: "visit-a" }), false);
});

test("a resolved call clears only its own success notice", () => {
  const notice = { kind: "success", message: "スタッフを呼び出しました。", staffCallId: "call-current" };
  assert.equal(isCustomerStaffCallSuccessNotice(notice, "call-current"), true);
  assert.equal(isCustomerStaffCallSuccessNotice(notice, "call-other"), false);
  assert.equal(isCustomerStaffCallSuccessNotice({ ...notice, staffCallId: undefined }, "call-current"), false);
  assert.equal(isCustomerStaffCallSuccessNotice({ ...notice, kind: "failed" }, "call-current"), false);
});
