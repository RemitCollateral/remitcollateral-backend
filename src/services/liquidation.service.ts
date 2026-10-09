import { config } from "../config";
import { Loan } from "../types";
import { loans, beneficiaries } from "../stores";
import { ContractGateway } from "../contracts/gateway.interface";
import { logAuditEvent } from "./audit.service";
import * as vaultService from "./vault.service";
import * as notifications from "./notification.service";
import { outstandingCollateral, outstandingPrincipal } from "./loan.service";
import { refreshReputationScore } from "./reputation.service";
import { activeChain } from "../chain/runtime";
import type { ChainPort } from "../chain/runtime";
import { applyChainState } from "./loan-chain.service";

// ─── Module-level gateway reference ──────────────────────────────────

let contractGateway: ContractGateway | undefined;

export function setContractGateway(gateway: ContractGateway): void {
  contractGateway = gateway;
}

// ─── Result Shapes ───────────────────────────────────────────────────

export interface LoanEvaluation {
  loanId: string;
  previousStatus: Loan["status"];
  currentStatus: Loan["status"];
  newlyOverdue: number[];
  graceExpiresAt?: string;
  liquidation?: LiquidationOutcome;
}

export interface LiquidationOutcome {
  outstandingPrincipalUsd: number;
  forfeitedUsd: number;
  returnedUsd: number;
  settlementAddress: string;
  txHash?: string;
}

// ─── Lifecycle Evaluation (§3.5) ─────────────────────────────────────

/**
 * Evaluate one loan against the clock and advance its status.
 *
 *   active  → grace       when an installment passes its due date
 *   grace   → active      handled on attestation, not here
 *   grace   → defaulted   when the grace period expires unpaid
 *
 * Marking installments overdue is not merely cosmetic: it is the signal the
 * §8 repayment score reads. Without it a beneficiary who never pays scores
 * identically to one with no history at all, and the LTV they qualify for
 * never reflects the miss.
 */
export async function evaluateLoan(
  loan: Loan,
  now: Date = new Date(),
): Promise<LoanEvaluation> {
  const previousStatus = loan.status;
  const evaluation: LoanEvaluation = {
    loanId: loan.id,
    previousStatus,
    currentStatus: loan.status,
    newlyOverdue: [],
  };

  if (loan.status !== "active" && loan.status !== "grace") {
    return evaluation;
  }

  // With the contracts connected the chain decides when a loan is overdue or
  // in default, and the sweep drives its cranks.
  const chain = activeChain();
  if (chain && loan.chainLoanId) {
    return evaluateChainLoan(loan, chain, now, evaluation);
  }

  // 1. Mark every unpaid installment whose due date has passed.
  for (const item of loan.schedule) {
    if (item.status === "pending" && new Date(item.dueAt) < now) {
      item.status = "overdue";
      evaluation.newlyOverdue.push(item.installmentNumber);
    }
  }

  const overdue = loan.schedule.filter((s) => s.status === "overdue");

  // 2. First miss opens the grace period and notifies both parties.
  if (overdue.length > 0 && loan.status === "active") {
    const graceExpiresAt = new Date(
      now.getTime() + config.protocol.gracePeriodDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    loan.status = "grace";
    loan.graceExpiresAt = graceExpiresAt;
    loan.updatedAt = now.toISOString();
    loans.set(loan.id, loan);
    recordGraceEntered(loan, overdue.map((s) => s.installmentNumber), graceExpiresAt);

    evaluation.currentStatus = loan.status;
    evaluation.graceExpiresAt = graceExpiresAt;
    return evaluation;
  }

  // 3. An expired grace period tips the loan into default.
  if (
    loan.status === "grace" &&
    loan.graceExpiresAt &&
    new Date(loan.graceExpiresAt) <= now
  ) {
    evaluation.liquidation = await liquidateLoan(loan, now);
    evaluation.currentStatus = loan.status;
    return evaluation;
  }

  if (evaluation.newlyOverdue.length > 0) {
    loan.updatedAt = now.toISOString();
    loans.set(loan.id, loan);
    refreshReputationScore(loan.beneficiaryId);
  }

  evaluation.currentStatus = loan.status;
  evaluation.graceExpiresAt = loan.graceExpiresAt;
  return evaluation;
}

/** The side effects of a loan entering its grace period, wherever the decision was made. */
function recordGraceEntered(loan: Loan, overdueInstallments: number[], graceExpiresAt: string, txHash?: string): void {
  logAuditEvent({
    eventType: "LOAN",
    action: "GRACE_PERIOD_ENTERED",
    actor: loan.guarantorId,
    entityType: "loan",
    entityId: loan.id,
    details: { overdueInstallments, graceExpiresAt, ...(txHash ? { txHash } : {}) },
  });

  const beneficiary = beneficiaries.get(loan.beneficiaryId);
  if (beneficiary && overdueInstallments.length > 0) {
    notifications.notifyGracePeriodEntered(loan, beneficiary, overdueInstallments[0]);
  }

  // The beneficiary now has an unpaid installment on record, so the
  // repayment score changes even before any default.
  refreshReputationScore(loan.beneficiaryId);
}

/** Record unpaid installments whose due date has passed. Returns the ones newly marked. */
function markOverdue(loan: Loan, now: Date): number[] {
  const marked: number[] = [];
  for (const item of loan.schedule) {
    if (item.status === "pending" && new Date(item.dueAt) < now) {
      item.status = "overdue";
      marked.push(item.installmentNumber);
    }
  }
  return marked;
}

/**
 * Evaluate a loan that lives on chain. The ledger's own dates decide: once an
 * installment is past due the overdue crank starts the grace period, and once
 * grace has run out the liquidation crank forfeits the collateral. Both are
 * permissionless and paid for by the verifier key. Each is a no-op for a loan
 * that needs neither, so the sweep is safe to repeat.
 */
async function evaluateChainLoan(
  loan: Loan,
  chain: ChainPort,
  now: Date,
  evaluation: LoanEvaluation,
): Promise<LoanEvaluation> {
  const id = BigInt(loan.chainLoanId!);
  let onChain = await chain.loan(id);
  if (!onChain) throw new Error(`Loan ${loan.chainLoanId} is not on chain`);

  // Anything the chain says that the backend did not already know happened
  // without the backend, so it is recorded as drift rather than absorbed.
  const drift = applyChainState(loan, onChain);
  if (drift.length > 0) {
    logAuditEvent({
      eventType: "SYSTEM",
      action: "LOAN_CHAIN_DRIFT",
      entityType: "loan",
      entityId: loan.id,
      details: { chainLoanId: loan.chainLoanId, fields: drift, found: "during the lifecycle sweep" },
    });
  }

  evaluation.newlyOverdue = markOverdue(loan, now);

  if (onChain.status === "active" && now.getTime() > onChain.nextDue.getTime()) {
    const txHash = await chain.flagOverdue(id);
    onChain = (await chain.loan(id)) ?? onChain;
    applyChainState(loan, onChain);
    // The ledger counts the next unpaid installment as the one that was missed,
    // whichever clock the backend's own due dates ran on.
    const missed = loan.schedule.find((s) => s.installmentNumber === onChain!.installmentsPaid + 1);
    if (missed?.status === "pending") missed.status = "overdue";
    recordGraceEntered(
      loan,
      loan.schedule.filter((s) => s.status === "overdue").map((s) => s.installmentNumber),
      loan.graceExpiresAt ?? "",
      txHash,
    );
  } else if (onChain.status === "grace" && onChain.graceExpiresAt && now.getTime() > onChain.graceExpiresAt.getTime()) {
    const stillLocked = onChain.collateralLockedUsd - onChain.collateralReleasedUsd;
    const outstanding = onChain.principalUsd - onChain.totalRepaidUsd;
    const { hash, forfeitedUsd } = await chain.liquidate(id);
    const returned = Math.max(0, stillLocked - forfeitedUsd);

    markOverdue(loan, new Date(8.64e15)); // every unpaid installment is now missed
    onChain = (await chain.loan(id)) ?? onChain;
    applyChainState(loan, onChain);
    loan.status = "defaulted";
    loan.collateralForfeitedUsd = forfeitedUsd;
    loan.graceExpiresAt = undefined;
    loan.updatedAt = now.toISOString();
    loans.set(loan.id, loan);

    const newScore = refreshReputationScore(loan.beneficiaryId);
    logAuditEvent({
      eventType: "LOAN",
      action: "LOAN_DEFAULTED",
      actor: loan.guarantorId,
      entityType: "loan",
      entityId: loan.id,
      details: {
        outstandingPrincipalUsd: outstanding,
        forfeitedUsd,
        returnedUsd: returned,
        settlementAddress: config.protocol.settlementAddress,
        chainLoanId: loan.chainLoanId,
        txHash: hash,
        beneficiaryScoreAfter: newScore,
      },
    });
    notifications.notifyCollateralForfeited(loan, forfeitedUsd, returned);

    evaluation.liquidation = {
      outstandingPrincipalUsd: outstanding,
      forfeitedUsd,
      returnedUsd: returned,
      settlementAddress: config.protocol.settlementAddress,
      txHash: hash,
    };
  } else if (evaluation.newlyOverdue.length > 0) {
    loan.updatedAt = now.toISOString();
    loans.set(loan.id, loan);
    refreshReputationScore(loan.beneficiaryId);
  }

  evaluation.currentStatus = loan.status;
  evaluation.graceExpiresAt = loan.graceExpiresAt;
  return evaluation;
}

// ─── Default & Liquidation (§3.5, §7.3) ──────────────────────────────

/**
 * Transition a loan to `defaulted` and settle the collateral.
 *
 * The forfeited amount is the outstanding principal, not the whole locked
 * position. Collateral is posted at 110–150% LTV, so forfeiting all of it
 * would take more from the guarantor than the protocol actually lost; the
 * excess above the outstanding balance is unlocked and returned to them.
 */
export async function liquidateLoan(
  loan: Loan,
  now: Date = new Date(),
): Promise<LiquidationOutcome> {
  const settlementAddress = config.protocol.settlementAddress;

  // 3. Calculate the outstanding balance.
  const outstanding = outstandingPrincipal(loan);
  const stillLocked = outstandingCollateral(loan);

  // 4. Forfeit the corresponding portion of collateral; return the excess.
  const forfeited = Math.round(Math.min(outstanding, stillLocked) * 100) / 100;
  const returned = Math.round((stillLocked - forfeited) * 100) / 100;

  // 5. Move the forfeited USDC to the platform settlement address. In v1
  //    this is a straight transfer — DEX-based liquidation is deferred.
  let txHash: string | undefined;
  if (contractGateway && forfeited > 0) {
    const result = await contractGateway.liquidateCollateral(
      loan.vaultId,
      loan.id,
      forfeited,
      settlementAddress,
    );

    if (!result.success) {
      throw new Error(`Liquidation failed on chain: ${result.failureReason}`);
    }
    txHash = result.txHash;
  }

  if (forfeited > 0) {
    vaultService.forfeitCollateral(loan.vaultId, forfeited);
  }
  if (returned > 0) {
    vaultService.releaseCollateral(loan.vaultId, returned);
  }

  // 2. Transition the loan and close out its schedule. Every installment
  //    left unpaid is recorded as missed, which is what feeds the §8 score.
  for (const item of loan.schedule) {
    if (item.status === "pending") {
      item.status = "overdue";
    }
  }

  loan.status = "defaulted";
  loan.collateralForfeitedUsd =
    Math.round((loan.collateralForfeitedUsd + forfeited) * 100) / 100;
  loan.collateralReleasedUsd =
    Math.round((loan.collateralReleasedUsd + returned) * 100) / 100;
  loan.graceExpiresAt = undefined;
  loan.updatedAt = now.toISOString();
  loans.set(loan.id, loan);

  if (contractGateway) {
    await contractGateway.closeLoan(loan.id, "defaulted");
  }

  // 6. Penalise the beneficiary's reputation. The penalty is not a stored
  //    decrement: the newly overdue installments drop the repayment score
  //    on recomputation, keeping the score reproducible from the underlying
  //    records as §8.4 requires.
  const newScore = refreshReputationScore(loan.beneficiaryId);

  logAuditEvent({
    eventType: "LOAN",
    action: "LOAN_DEFAULTED",
    actor: loan.guarantorId,
    entityType: "loan",
    entityId: loan.id,
    details: {
      outstandingPrincipalUsd: outstanding,
      forfeitedUsd: forfeited,
      returnedUsd: returned,
      settlementAddress,
      txHash,
      beneficiaryScoreAfter: newScore,
    },
  });

  notifications.notifyCollateralForfeited(loan, forfeited, returned);

  return {
    outstandingPrincipalUsd: outstanding,
    forfeitedUsd: forfeited,
    returnedUsd: returned,
    settlementAddress,
    txHash,
  };
}

// ─── Sweep (§7.3 scheduled job) ──────────────────────────────────────

export interface SweepResult {
  evaluatedAt: string;
  loansEvaluated: number;
  enteredGrace: string[];
  defaulted: string[];
  totalForfeitedUsd: number;
}

/**
 * Evaluate every open loan. Run on a schedule by the lifecycle job, and
 * on demand by an admin liquidation review.
 */
export async function sweepLoanLifecycle(now: Date = new Date()): Promise<SweepResult> {
  const open = Array.from(loans.values()).filter(
    (l) => l.status === "active" || l.status === "grace",
  );

  const result: SweepResult = {
    evaluatedAt: now.toISOString(),
    loansEvaluated: open.length,
    enteredGrace: [],
    defaulted: [],
    totalForfeitedUsd: 0,
  };

  for (const loan of open) {
    try {
      const evaluation = await evaluateLoan(loan, now);

      if (evaluation.previousStatus === "active" && evaluation.currentStatus === "grace") {
        result.enteredGrace.push(loan.id);
      }
      if (evaluation.currentStatus === "defaulted") {
        result.defaulted.push(loan.id);
        result.totalForfeitedUsd += evaluation.liquidation?.forfeitedUsd || 0;
      }
    } catch (err) {
      // One bad loan must not abort the sweep for every other guarantor.
      logAuditEvent({
        eventType: "SYSTEM",
        action: "LIFECYCLE_SWEEP_ERROR",
        entityType: "loan",
        entityId: loan.id,
        details: { message: (err as Error).message },
      });
    }
  }

  result.totalForfeitedUsd = Math.round(result.totalForfeitedUsd * 100) / 100;

  if (result.enteredGrace.length > 0 || result.defaulted.length > 0) {
    logAuditEvent({
      eventType: "SYSTEM",
      action: "LIFECYCLE_SWEEP_COMPLETED",
      details: result,
    });
  }

  return result;
}
