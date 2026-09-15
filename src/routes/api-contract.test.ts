/**
 * The API against the frontend's contract.
 *
 * Walks the guarantor's journey end to end, and checks every response carries
 * exactly the fields the frontend's lib/types.ts declares for it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../testing/server";
import { signIn } from "../testing/auth";
import { config } from "../config";

// Field lists from remitcollateral-frontend/lib/types.ts.
const GUARANTOR = ["id", "wallet_address", "display_name", "created_at"];
const VAULT = ["id", "guarantor_id", "collateral_balance", "locked_amount", "available_amount", "created_at"];
const BENEFICIARY = ["id", "phone_number", "local_kyc_ref", "reputation_score", "display_name", "local_currency", "created_at"];
const REPUTATION = [
  "beneficiary_id", "composite_score", "remittance_score", "repayment_score", "remittance_months_observed",
  "remittance_meets_minimum_history", "on_time_repayment_rate", "loans_completed", "loans_defaulted", "qualified_ltv",
];
const SCHEDULE_ENTRY = ["installment", "amount_local", "due_at", "paid_at", "status"];
const LOAN = [
  "id", "vault_id", "beneficiary_id", "principal_local", "principal_usd", "local_currency", "ltv_ratio",
  "installment_count", "schedule", "status", "grace_expires_at", "purpose", "created_at", "updated_at",
];
const LOAN_VIEW = [
  ...LOAN, "beneficiary", "total_repaid_local", "outstanding_local", "collateral_locked_usd",
  "collateral_released_usd", "next_installment", "missed_installments",
];
const ATTESTATION = ["id", "loan_id", "installment_number", "amount_local", "amount_usd", "attested_by", "attested_at", "created_at"];
const REMITTANCE = ["id", "guarantor_id", "beneficiary_id", "amount_usd", "local_amount", "local_currency", "source", "sent_at", "created_at"];
const DASHBOARD = ["guarantor", "vault", "loans", "upcoming_installments", "at_risk_loans"];
const UPCOMING = ["loan_id", "beneficiary_name", "local_currency", "entry"];

function assertShape(value: unknown, fields: string[], what: string): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${what} is an object`);
  assert.deepEqual(Object.keys(value as object).sort(), [...fields].sort(), `${what} fields`);
  return value as Record<string, any>;
}

let base = "";
let close: () => Promise<void>;
let token = "";
let wallet = "";
let beneficiaryId = "";
let loanId = "";
const savedPartnerKey = config.partnerApiKey;

before(async () => {
  ({ base, close } = await startTestServer());
  const signedIn = await signIn(base);
  token = signedIn.token;
  wallet = signedIn.key.publicKey();
  config.partnerApiKey = "contract-test-partner-key";
});
after(async () => {
  config.partnerApiKey = savedPartnerKey;
  await close();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

test("GET /guarantors/me is the guarantor itself", async () => {
  const { status, body } = await call("GET", "/guarantors/me");
  assert.equal(status, 200);
  assertShape(body, GUARANTOR, "guarantor");
  assert.equal(body.wallet_address, wallet);
});

test("the vault reads and deposits as a VaultSummary", async () => {
  const empty = await call("GET", "/vaults/me");
  assertShape(empty.body, VAULT, "vault");
  assert.equal(empty.body.collateral_balance, 0);

  const funded = await call("POST", "/vaults/deposit", { amount_usd: 5000, tx_hash: "abc" });
  assert.equal(funded.status, 200);
  assertShape(funded.body, VAULT, "vault after deposit");
  assert.equal(funded.body.collateral_balance, 5000);
  assert.equal(funded.body.available_amount, 5000);
});

test("beneficiaries register and read in the frontend's shape", async () => {
  const missingKyc = await call("POST", "/beneficiaries", { phone_number: "+2348000000001", local_currency: "NGN" });
  assert.equal(missingKyc.status, 400);
  assert.match(missingKyc.body.message, /local_kyc_ref/, "the reason reaches the frontend as `message`");

  const created = await call("POST", "/beneficiaries", {
    phone_number: "+2348000000001",
    local_kyc_ref: "PARTNER-NG-1",
    display_name: "Amaka Obi",
    local_currency: "ngn",
  });
  assert.equal(created.status, 201);
  const b = assertShape(created.body, BENEFICIARY, "beneficiary");
  assert.equal(b.local_currency, "NGN");
  assert.equal(b.display_name, "Amaka Obi");
  assert.ok(b.reputation_score >= 0 && b.reputation_score <= 1, "score on a 0–1 scale");
  beneficiaryId = b.id;

  const read = await call("GET", `/beneficiaries/${beneficiaryId}`);
  assertShape(read.body, BENEFICIARY, "beneficiary read");

  const reputation = await call("GET", `/beneficiaries/${beneficiaryId}/reputation`);
  const r = assertShape(reputation.body, REPUTATION, "reputation");
  assert.ok(r.composite_score >= 0 && r.composite_score <= 1);
  assert.ok(r.qualified_ltv >= 1.1 && r.qualified_ltv <= 1.5);
});

test("a duplicate phone number is refused without disclosing the existing beneficiary", async () => {
  const other = await signIn(base);
  const res = await fetch(`${base}/api/v1/beneficiaries`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${other.token}` },
    body: JSON.stringify({ phone_number: "+2348000000001", local_kyc_ref: "X", local_currency: "NGN" }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.beneficiary, undefined);
  assert.ok(!JSON.stringify(body).includes("PARTNER-NG-1"));
});

test("a new loan comes back as a Loan with a live schedule", async () => {
  const { status, body } = await call("POST", "/loans", {
    beneficiary_id: beneficiaryId,
    principal_local: 400,
    local_currency: "NGN",
    installment_count: 4,
    installment_interval_days: 30,
    purpose: "Restocking the shop",
  });
  assert.equal(status, 201, JSON.stringify(body));
  const loan = assertShape(body, LOAN, "loan");
  assert.equal(loan.schedule.length, 4);
  loan.schedule.forEach((entry: unknown, i: number) => assertShape(entry, SCHEDULE_ENTRY, `schedule[${i}]`));
  assert.deepEqual(loan.schedule.map((e: any) => e.status), ["due", "upcoming", "upcoming", "upcoming"]);
  assert.equal(loan.purpose, "Restocking the shop");
  loanId = loan.id;
});

test("loans list and read as LoanWithBeneficiary", async () => {
  const list = await call("GET", "/loans");
  assert.ok(Array.isArray(list.body), "GET /loans is an array");
  assert.equal(list.body.length, 1);
  const view = assertShape(list.body[0], LOAN_VIEW, "loan view");
  assertShape(view.beneficiary, BENEFICIARY, "loan view beneficiary");
  assertShape(view.next_installment, SCHEDULE_ENTRY, "next installment");
  assert.equal(view.next_installment.installment, 1);
  assert.equal(view.missed_installments, 0);
  assert.ok(view.collateral_locked_usd > 0);

  const one = await call("GET", `/loans/${loanId}`);
  assertShape(one.body, LOAN_VIEW, "GET /loans/:id");

  const schedule = await call("GET", `/loans/${loanId}/schedule`);
  assert.ok(Array.isArray(schedule.body));
  schedule.body.forEach((entry: unknown) => assertShape(entry, SCHEDULE_ENTRY, "schedule entry"));

  const repayments = await call("GET", `/loans/${loanId}/repayments`);
  assert.deepEqual(repayments.body, []);

  const missing = await call("GET", "/loans/not-a-loan");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, "Loan not found");
});

test("a partner-attested repayment shows as paid, with collateral released", async () => {
  const schedule = (await call("GET", `/loans/${loanId}/schedule`)).body;
  const loan = (await call("GET", `/loans/${loanId}`)).body;
  const attest = await fetch(`${base}/api/v1/repayments/attest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.partnerApiKey },
    body: JSON.stringify({
      loanId,
      installmentNumber: 1,
      amountLocal: schedule[0].amount_local,
      amountUsd: loan.principal_usd / 4,
      partnerSignature: "partner-signature",
    }),
  });
  assert.equal(attest.status, 200, await attest.clone().text());

  const view = (await call("GET", `/loans/${loanId}`)).body;
  assert.equal(view.schedule[0].status, "paid");
  assert.ok(view.schedule[0].paid_at, "a paid installment carries paid_at");
  assert.equal(view.schedule[1].status, "due");
  assert.equal(view.total_repaid_local, schedule[0].amount_local);
  assert.equal(view.next_installment.installment, 2);
  assert.ok(view.collateral_released_usd > 0);

  const repayments = (await call("GET", `/loans/${loanId}/repayments`)).body;
  assert.equal(repayments.length, 1);
  assertShape(repayments[0], ATTESTATION, "attestation");
});

test("the dashboard carries the frontend's DashboardData", async () => {
  const { status, body } = await call("GET", "/guarantors/me/dashboard");
  assert.equal(status, 200);
  const d = assertShape(body, DASHBOARD, "dashboard");
  assertShape(d.guarantor, GUARANTOR, "dashboard guarantor");
  assertShape(d.vault, VAULT, "dashboard vault");
  assert.equal(d.loans.length, 1);
  assertShape(d.loans[0], LOAN_VIEW, "dashboard loan");
  assert.ok(d.upcoming_installments.length > 0);
  d.upcoming_installments.forEach((u: unknown) => {
    const upcoming = assertShape(u, UPCOMING, "upcoming installment");
    assert.equal(upcoming.beneficiary_name, "Amaka Obi");
    assertShape(upcoming.entry, SCHEDULE_ENTRY, "upcoming entry");
  });
  assert.deepEqual(d.at_risk_loans, []);
  assert.ok(d.vault.locked_amount > 0);
});

test("remittances record and list as RemittanceRecord, always self-declared", async () => {
  const created = await call("POST", "/remittances", {
    beneficiary_id: beneficiaryId,
    amount_usd: 200,
    local_amount: 316000,
    local_currency: "NGN",
    sent_at: new Date(Date.now() - 86_400_000).toISOString(),
    source: "partner_reported",
  });
  assert.equal(created.status, 201);
  const record = assertShape(created.body, REMITTANCE, "remittance");
  assert.equal(record.source, "self_declared", "a guarantor cannot claim partner-reported history");

  const list = await call("GET", "/remittances");
  assert.ok(Array.isArray(list.body));
  assertShape(list.body[0], REMITTANCE, "listed remittance");
});

test("withdrawal needs no destination and returns a VaultSummary", async () => {
  const before = (await call("GET", "/vaults/me")).body;
  const res = await call("POST", "/vaults/withdraw", { amount_usd: 100 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertShape(res.body, VAULT, "vault after withdrawal");
  assert.equal(res.body.collateral_balance, before.collateral_balance - 100);

  const tooMuch = await call("POST", "/vaults/withdraw", { amount_usd: 1_000_000 });
  assert.equal(tooMuch.status, 400);
  assert.equal(typeof tooMuch.body.message, "string");
});
