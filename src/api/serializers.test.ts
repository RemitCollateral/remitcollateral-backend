import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeReputation, serializeSchedule } from "./serializers";
import { InstallmentScheduleItem } from "../types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T00:00:00Z");
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const item = (n: number, dueInDays: number, status: InstallmentScheduleItem["status"], repaidAt?: string) =>
  ({ installmentNumber: n, amountLocal: 100, amountUsd: 1, dueAt: at(dueInDays), status, repaidAt }) as InstallmentScheduleItem;

test("installment status follows the clock, not just the stored status", () => {
  const entries = serializeSchedule(
    [
      item(1, -40, "repaid", at(-41)),
      item(2, -10, "pending"), // past due, not yet swept: already overdue
      item(3, 20, "pending"), // soonest future installment
      item(4, 50, "pending"),
    ],
    NOW,
  );
  assert.deepEqual(entries.map((e) => e.status), ["paid", "overdue", "due", "upcoming"]);
  assert.equal(entries[0].paid_at, at(-41));
  assert.equal(entries[1].paid_at, null);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["amount_local", "due_at", "installment", "paid_at", "status"]);
});

test("the schedule comes back in installment order", () => {
  const entries = serializeSchedule([item(2, 60, "pending"), item(1, 30, "pending")], NOW);
  assert.deepEqual(entries.map((e) => e.installment), [1, 2]);
  assert.deepEqual(entries.map((e) => e.status), ["due", "upcoming"]);
});

test("reputation is reported on a 0–1 scale", () => {
  const r = serializeReputation("b1", {
    compositeScore: 84,
    remittanceScore: 70,
    repaymentScore: 93,
    adjustedLtv: 1.16,
    historyMonths: 7.4,
    loansCompleted: 2,
    loansDefaulted: 0,
  });
  assert.equal(r.composite_score, 0.84);
  assert.equal(r.remittance_score, 0.7);
  assert.equal(r.repayment_score, 0.93);
  assert.equal(r.on_time_repayment_rate, 0.93);
  assert.equal(r.remittance_months_observed, 7);
  assert.equal(r.remittance_meets_minimum_history, true);
  assert.equal(r.qualified_ltv, 1.16);
});
