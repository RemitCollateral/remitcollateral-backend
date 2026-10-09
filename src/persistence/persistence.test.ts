/**
 * The stores survive a restart. Needs a PostgreSQL to write to: set
 * TEST_DATABASE_URL to an empty scratch database (these tests drop its tables).
 * Without it the tests are skipped.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "TEST_DATABASE_URL is not set";
if (url) process.env.DATABASE_URL = url;

import { startTestServer } from "../testing/server";
import { signIn } from "../testing/auth";
import { closePool, getPool, TABLES } from "./database";
import { flushNow, initPersistence, loadStores, stopPersistence } from "./snapshot";
import {
  auditEvents,
  beneficiaries,
  beneficiaryLinks,
  guarantors,
  guarantorToVault,
  loans,
  remittanceRecords,
  repaymentAttestations,
  sessions,
  vaults,
  walletToGuarantor,
} from "../stores";

let close: () => Promise<void> = async () => undefined;
let base = "";

before(async () => {
  if (skip) return;
  const pool = getPool();
  await pool.query(`DROP TABLE IF EXISTS ${[...TABLES, "schema_migrations"].join(", ")}`);
  await initPersistence();
  ({ base, close } = await startTestServer());
});

after(async () => {
  if (skip) return;
  await close();
  await stopPersistence();
  await closePool();
});

/** What a restart does to the process: the stores are gone, and the database is read back. */
async function restart(): Promise<void> {
  await flushNow();
  for (const store of [guarantors, vaults, beneficiaries, beneficiaryLinks, loans, sessions, walletToGuarantor, guarantorToVault]) {
    store.clear();
  }
  for (const list of [remittanceRecords, repaymentAttestations, auditEvents]) list.length = 0;
  await loadStores();
}

const guarantor = { id: "g-1", walletAddress: "GWALLET1", createdAt: "2026-10-01T00:00:00.000Z" };
const vault = { id: "v-1", guarantorId: "g-1", collateralBalance: 100, lockedAmount: 40, createdAt: "2026-10-01T00:00:00.000Z" };
const beneficiary: any = { id: "b-1", phoneNumber: "+2348000000000", localKycRef: "kyc-1", createdAt: "2026-10-01T00:00:00.000Z" };
const link = { guarantorId: "g-1", beneficiaryId: "b-1", displayName: "Mum", createdAt: "2026-10-01T00:00:00.000Z" };
const loan: any = {
  id: "l-1", vaultId: "v-1", guarantorId: "g-1", beneficiaryId: "b-1", status: "active", principalUsd: 30,
  schedule: [{ installmentNumber: 1, status: "pending", dueAt: "2026-11-01T00:00:00.000Z" }],
  createdAt: "2026-10-01T00:00:00.000Z",
};

test("every kind of record survives a restart", { skip }, async () => {
  guarantors.set(guarantor.id, guarantor);
  walletToGuarantor.set(guarantor.walletAddress, guarantor.id);
  vaults.set(vault.id, vault);
  guarantorToVault.set(vault.guarantorId, vault.id);
  beneficiaries.set(beneficiary.id, beneficiary);
  beneficiaryLinks.set("g-1", new Map([["b-1", link]]));
  loans.set(loan.id, loan);
  remittanceRecords.push({ id: "r-1", guarantorId: "g-1", beneficiaryId: "b-1", amountUsd: 10, localAmount: 15800, localCurrency: "NGN", source: "partner_reported", sentAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" });
  repaymentAttestations.push({ id: "a-1", loanId: "l-1", installmentNumber: 1, amountLocal: 1, amountUsd: 1, attestedBy: "p", partnerSignature: "s", attestedAt: "2026-10-02T00:00:00.000Z", createdAt: "2026-10-02T00:00:00.000Z" });
  auditEvents.push({ id: "e-1", eventType: "LOAN", action: "LOAN_ORIGINATED", details: { x: 1 }, createdAt: "2026-10-02T00:00:00.000Z" });
  sessions.set("hash-1", { walletAddress: "GWALLET1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

  await restart();

  assert.deepEqual(guarantors.get("g-1"), guarantor);
  assert.deepEqual(vaults.get("v-1"), vault);
  assert.deepEqual(beneficiaries.get("b-1"), beneficiary);
  assert.deepEqual(beneficiaryLinks.get("g-1")?.get("b-1"), link);
  assert.deepEqual(loans.get("l-1"), loan);
  assert.equal(remittanceRecords.length, 1);
  assert.equal(repaymentAttestations[0].id, "a-1");
  assert.deepEqual(auditEvents.map((e) => e.id), ["e-1"]);
  assert.equal(sessions.get("hash-1")?.walletAddress, "GWALLET1");
  // The lookup indexes are rebuilt, not stored.
  assert.equal(walletToGuarantor.get("GWALLET1"), "g-1");
  assert.equal(guarantorToVault.get("g-1"), "v-1");
});

test("a change made in place to a stored entity is written", { skip }, async () => {
  const stored = loans.get("l-1")!;
  stored.status = "repaid";
  stored.schedule[0].status = "repaid";

  await restart();

  assert.equal(loans.get("l-1")?.status, "repaid");
  assert.equal(loans.get("l-1")?.schedule[0].status, "repaid");
});

test("a removed entity is removed from the database", { skip }, async () => {
  sessions.delete("hash-1");
  await restart();
  assert.equal(sessions.has("hash-1"), false);
});

test("appending is not repeated: flushing twice stores each event once", { skip }, async () => {
  auditEvents.push({ id: "e-2", eventType: "LOAN", action: "X", details: "y", createdAt: "2026-10-03T00:00:00.000Z" });
  await flushNow();
  await flushNow();
  const { rows } = await getPool().query("SELECT count(*)::int AS n FROM audit_events");
  assert.equal(rows[0].n, 2);
  await restart();
  assert.deepEqual(auditEvents.map((e) => e.id), ["e-1", "e-2"]);
});

test("a session that expired while the process was down is not restored", { skip }, async () => {
  sessions.set("stale", { walletAddress: "GWALLET1", expiresAt: new Date(Date.now() - 1000).toISOString() });
  await restart();
  assert.equal(sessions.has("stale"), false);
});

test("a signed-in guarantor is still signed in after a restart", { skip }, async () => {
  const { token, key } = await signIn(base);
  const before = await fetch(`${base}/api/v1/guarantors/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(before.status, 200);

  await restart();

  const after = await fetch(`${base}/api/v1/guarantors/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.status, 200);
  assert.equal(((await after.json()) as any).wallet_address, key.publicKey());
});

test("health reports the database", { skip }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).database, "ok");
});
