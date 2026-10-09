/**
 * Repayments and the lifecycle sweep with the contracts connected, against a
 * fake chain that applies the ledger's own rules: a repayment releases
 * collateral pro rata less the safety buffer, closing releases the rest, an
 * overdue loan enters grace, and an expired grace is liquidated.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { MockOffRampAdapter } from "../adapters/mock-offramp.adapter";
import { signAttestation } from "../chain/attestation";
import { ChainError } from "../chain/errors";
import { setChain, setPartnerSigner, ChainPort } from "../chain/runtime";
import type { ChainLoan } from "../chain/soroban";
import { config } from "../config";
import { beneficiaries, generateId, loans, repaymentAttestations } from "../stores";
import { ChainLoanDraft, Loan, OffRampAttestation } from "../types";
import { queryAuditEvents } from "./audit.service";
import { reconcileLoan } from "./loan-chain.service";
import * as loanService from "./loan.service";
import { sweepLoanLifecycle } from "./liquidation.service";
import { startTestServer } from "../testing/server";
import { signIn } from "../testing/auth";

const DAY = 24 * 60 * 60 * 1000;
const partner = Keypair.random();
const savedPartner = config.chain.partnerAddress;

let chainNow = Date.now();
const onChain = new Map<bigint, ChainLoan>();
const calls: string[] = [];
let failNextAttest = false;

const cents = (usd: number) => Math.round(usd * 100);

const fakeChain = {
  loan: async (id: bigint) => onChain.get(id) ?? null,
  attestRepayment: async (input: { partner: string; loanId: bigint; amountUsd: number; signPartnerAuthEntry: unknown }) => {
    calls.push(`attest:${input.loanId}:${input.amountUsd.toFixed(2)}`);
    if (failNextAttest) {
      failNextAttest = false;
      throw new ChainError("network unavailable");
    }
    const loan = onChain.get(input.loanId)!;
    assert.equal(input.partner, loan.partner, "the loan's own partner co-signs");
    assert.equal(typeof input.signPartnerAuthEntry, "function");
    loan.totalRepaidUsd = (cents(loan.totalRepaidUsd) + cents(input.amountUsd)) / 100;
    loan.installmentsPaid = Math.floor((cents(loan.totalRepaidUsd) * loan.installmentCount) / cents(loan.principalUsd));
    const fullyRepaid = cents(loan.totalRepaidUsd) >= cents(loan.principalUsd);
    const releasable = fullyRepaid
      ? loan.collateralLockedUsd
      : (loan.collateralLockedUsd * loan.totalRepaidUsd * (1 - 0.05)) / loan.principalUsd;
    const release = Math.round((releasable - loan.collateralReleasedUsd) * 100) / 100;
    loan.collateralReleasedUsd = Math.round((loan.collateralReleasedUsd + release) * 100) / 100;
    if (fullyRepaid) loan.status = "repaid";
    else loan.nextDue = new Date(loan.originatedAt.getTime() + (loan.installmentsPaid + 1) * loan.intervalSecs * 1000);
    return { hash: `attest-${calls.length}`, releasedUsd: release };
  },
  flagOverdue: async (id: bigint) => {
    calls.push(`flag:${id}`);
    const loan = onChain.get(id)!;
    if (loan.status !== "active" || chainNow <= loan.nextDue.getTime()) throw new ChainError("not overdue");
    loan.status = "grace";
    loan.graceExpiresAt = new Date(chainNow + 14 * DAY);
    return `flag-${calls.length}`;
  },
  liquidate: async (id: bigint) => {
    calls.push(`liquidate:${id}`);
    const loan = onChain.get(id)!;
    if (loan.status !== "grace" || chainNow <= loan.graceExpiresAt!.getTime()) throw new ChainError("grace not expired");
    const outstanding = loan.principalUsd - loan.totalRepaidUsd;
    const remaining = loan.collateralLockedUsd - loan.collateralReleasedUsd;
    const forfeitedUsd = Math.min(outstanding, remaining);
    loan.collateralReleasedUsd = loan.collateralLockedUsd - 0; // forfeited + returned both leave the lock
    loan.status = "defaulted";
    return { hash: `liquidate-${calls.length}`, forfeitedUsd };
  },
} as unknown as ChainPort;

before(() => {
  config.chain.partnerAddress = partner.publicKey();
  loanService.setOffRampAdapter(new MockOffRampAdapter());
  setChain(fakeChain);
  setPartnerSigner((async () => ({ signedAuthEntry: "signed" })) as never);
});
after(() => {
  config.chain.partnerAddress = savedPartner;
  setChain(null);
  setPartnerSigner(null);
});
beforeEach(() => {
  loans.clear();
  onChain.clear();
  calls.length = 0;
  failNextAttest = false;
  chainNow = Date.now();
});

let nextId = 5000n;
async function newLoan(guarantorId = generateId()): Promise<{ loan: Loan; chainId: bigint }> {
  const beneficiaryId = generateId();
  beneficiaries.set(beneficiaryId, {
    id: beneficiaryId, phoneNumber: "+2348012340000", localKycRef: "LIFECYCLE", localCurrency: "NGN",
    reputationScore: 0, createdAt: new Date().toISOString(),
  } as never);
  const chainId = nextId++;
  const originatedAt = new Date(chainNow);
  const chainLoan: ChainLoan = {
    id: chainId, guarantor: "GTEST", beneficiaryHandle: "h", partner: partner.publicKey(), principalUsd: 100, ltvBps: 15_000,
    collateralLockedUsd: 150, collateralReleasedUsd: 0, installmentCount: 3, intervalSecs: 30 * 24 * 3600, originatedAt,
    installmentsPaid: 0, totalRepaidUsd: 0, nextDue: new Date(chainNow + 30 * DAY), graceExpiresAt: null, status: "active",
  };
  onChain.set(chainId, chainLoan);
  const draft: ChainLoanDraft = {
    beneficiaryId, principalLocal: 100_000, localCurrency: "NGN", installmentCount: 3, intervalDays: 30, fxRate: 1000,
    principalUsd: 100, ltvRatio: 1.5,
  };
  const loan = await loanService.recordChainLoan(guarantorId, draft, chainLoan);
  return { loan, chainId };
}

/** The attestation the partner would send for an installment, signed with its key. */
function attestationFor(loan: Loan, n: number, signer: Keypair = partner): OffRampAttestation {
  const item = loan.schedule.find((s) => s.installmentNumber === n)!;
  const body = {
    loan_id: loan.id, installment_number: n, amount_local: item.amountLocal, amount_usd: item.amountUsd,
    attested_at: new Date(chainNow).toISOString(),
  };
  return { ...body, beneficiary_phone: "", partner_signature: signAttestation(signer, body) };
}

test("a repayment is settled on chain and the loan follows what the chain did", async () => {
  const { loan, chainId } = await newLoan();

  const first = await loanService.processRepaymentAttestation(attestationFor(loan, 1), "partner");
  assert.deepEqual(calls, [`attest:${chainId}:33.34`], "to the cent, so the ledger counts the installment as covered");
  assert.equal(onChain.get(chainId)!.installmentsPaid, 1);
  assert.equal(first.collateralReleased, onChain.get(chainId)!.collateralReleasedUsd);
  assert.equal(loan.collateralReleasedUsd, onChain.get(chainId)!.collateralReleasedUsd);
  assert.equal(loan.schedule[0].status, "repaid");
  assert.equal(loan.schedule[1].status, "pending");

  await loanService.processRepaymentAttestation(attestationFor(loan, 2), "partner");
  await loanService.processRepaymentAttestation(attestationFor(loan, 3), "partner");

  assert.equal(onChain.get(chainId)!.status, "repaid");
  assert.equal(loan.status, "repaid");
  assert.equal(loan.collateralReleasedUsd, 150, "closing returns the safety buffer too");
  assert.ok(loan.schedule.every((s) => s.status === "repaid"));
  assert.equal(repaymentAttestations.filter((a) => a.loanId === loan.id).length, 3);
});

test("an attestation not signed by the partner's key is refused before anything reaches the chain", async () => {
  const { loan } = await newLoan();
  const wrongKey = attestationFor(loan, 1, Keypair.random());
  const otherInstallment = { ...attestationFor(loan, 2), installment_number: 1 };
  const unsigned = { ...attestationFor(loan, 1), partner_signature: "anything-non-empty" };

  for (const bad of [wrongKey, otherInstallment, unsigned]) {
    await assert.rejects(loanService.processRepaymentAttestation(bad, "partner"), /Invalid attestation signature/);
  }
  assert.deepEqual(calls, []);
  assert.equal(repaymentAttestations.filter((a) => a.loanId === loan.id).length, 0);
});

test("a signed attestation for the wrong amount is refused", async () => {
  const { loan } = await newLoan();
  const item = loan.schedule[0];
  const body = {
    loan_id: loan.id, installment_number: 1, amount_local: item.amountLocal, amount_usd: 1,
    attested_at: new Date().toISOString(),
  };
  const att: OffRampAttestation = { ...body, beneficiary_phone: "", partner_signature: signAttestation(partner, body) };
  await assert.rejects(loanService.processRepaymentAttestation(att, "partner"), /does not match installment 1/);
  assert.deepEqual(calls, []);
});

test("installments are repaid in order", async () => {
  const { loan } = await newLoan();
  await assert.rejects(
    loanService.processRepaymentAttestation(attestationFor(loan, 2), "partner"),
    /Installment 1 must be repaid before installment 2/,
  );
  assert.deepEqual(calls, []);
});

test("a chain failure records nothing, and the retry settles it once", async () => {
  const { loan, chainId } = await newLoan();
  failNextAttest = true;
  await assert.rejects(loanService.processRepaymentAttestation(attestationFor(loan, 1), "partner"), /network unavailable/);
  assert.equal(repaymentAttestations.filter((a) => a.loanId === loan.id).length, 0);
  assert.equal(loan.schedule[0].status, "pending");

  await loanService.processRepaymentAttestation(attestationFor(loan, 1), "partner");
  assert.equal(onChain.get(chainId)!.installmentsPaid, 1);
  assert.equal(calls.filter((c) => c.startsWith("attest")).length, 2, "one failed attempt, one that landed");
});

test("an installment the chain already counts is recorded, not sent a second time", async () => {
  const { loan, chainId } = await newLoan();
  // The chain accepted it, then the backend crashed before recording it.
  await fakeChain.attestRepayment({ partner: partner.publicKey(), loanId: chainId, amountUsd: 33.34, signPartnerAuthEntry: () => 0 } as never);
  calls.length = 0;

  await loanService.processRepaymentAttestation(attestationFor(loan, 1), "partner");

  assert.deepEqual(calls, []);
  assert.equal(loan.schedule[0].status, "repaid");
  assert.equal(repaymentAttestations.filter((a) => a.loanId === loan.id).length, 1);
});

test("a deployment holding no partner key cannot settle a repayment on chain", async () => {
  const { loan } = await newLoan();
  setPartnerSigner(null);
  try {
    await assert.rejects(loanService.processRepaymentAttestation(attestationFor(loan, 1), "partner"), /cannot co-sign/);
    assert.deepEqual(calls, []);
  } finally {
    setPartnerSigner((async () => ({ signedAuthEntry: "signed" })) as never);
  }
});

test("the sweep leaves a loan that is not due alone", async () => {
  const { loan } = await newLoan();
  await sweepLoanLifecycle(new Date(chainNow + 29 * DAY));
  assert.deepEqual(calls, []);
  assert.equal(loan.status, "active");
});

test("the sweep starts grace through the chain, then liquidates through it", async () => {
  const { loan, chainId } = await newLoan();

  chainNow += 31 * DAY;
  const afterMiss = await sweepLoanLifecycle(new Date(chainNow));
  assert.deepEqual(calls, [`flag:${chainId}`]);
  assert.deepEqual(afterMiss.enteredGrace, [loan.id]);
  assert.equal(loan.status, "grace");
  assert.equal(loan.graceExpiresAt, onChain.get(chainId)!.graceExpiresAt!.toISOString(), "the ledger's deadline, not the backend's");
  assert.equal(loan.schedule[0].status, "overdue");

  // Running it again changes nothing.
  await sweepLoanLifecycle(new Date(chainNow));
  assert.deepEqual(calls, [`flag:${chainId}`]);

  chainNow += 15 * DAY;
  const afterGrace = await sweepLoanLifecycle(new Date(chainNow));
  assert.deepEqual(calls, [`flag:${chainId}`, `liquidate:${chainId}`]);
  assert.deepEqual(afterGrace.defaulted, [loan.id]);
  assert.equal(loan.status, "defaulted");
  assert.equal(loan.collateralForfeitedUsd, 100, "the outstanding principal, not the 150 locked");
  assert.equal(afterGrace.totalForfeitedUsd, 100);

  const audited = queryAuditEvents({ entityType: "loan", entityId: loan.id }).events.map((e) => e.action);
  assert.ok(audited.includes("GRACE_PERIOD_ENTERED") && audited.includes("LOAN_DEFAULTED"));
});

test("the sweep waits for the ledger to call a loan overdue, even if the backend's clock is ahead", async () => {
  const { loan, chainId } = await newLoan();
  chainNow += 31 * DAY;
  // The backend's clock is ahead of the chain's: the ledger says not overdue yet.
  onChain.get(chainId)!.nextDue = new Date(chainNow + 1000);
  const result = await sweepLoanLifecycle(new Date(chainNow - 1000));
  assert.deepEqual(result.enteredGrace, []);
  assert.deepEqual(calls, []);
  assert.equal(loan.status, "active");
});

test("a difference between the chain and the backend is audited and the chain wins", async () => {
  const { loan, chainId } = await newLoan();
  const chainLoan = onChain.get(chainId)!;
  chainLoan.status = "repaid";
  chainLoan.installmentsPaid = 3;
  chainLoan.totalRepaidUsd = 100;
  chainLoan.collateralReleasedUsd = 150;

  await reconcileLoan(loan);

  assert.equal(loan.status, "repaid");
  assert.equal(loan.collateralReleasedUsd, 150);
  assert.ok(loan.schedule.every((s) => s.status === "repaid"));
  const drift = queryAuditEvents({ entityId: loan.id }).events.filter((e) => e.action === "LOAN_CHAIN_DRIFT");
  assert.equal(drift.length, 1);

  await reconcileLoan(loan);
  assert.equal(queryAuditEvents({ entityId: loan.id }).events.filter((e) => e.action === "LOAN_CHAIN_DRIFT").length, 1, "nothing further to report");
});

test("GET /loans/:id reflects the chain", async () => {
  const server = await startTestServer();
  try {
    const { token } = await signIn(server.base);
    const me = (await (await fetch(`${server.base}/api/v1/guarantors/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string };
    const { loan, chainId } = await newLoan(me.id);
    onChain.get(chainId)!.status = "grace";
    onChain.get(chainId)!.graceExpiresAt = new Date(chainNow + 5 * DAY);

    const res = await fetch(`${server.base}/api/v1/loans/${loan.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "grace");
  } finally {
    await server.close();
  }
});
