import { config } from "../config";
import { logger } from "../logging/logger";
import {
  Loan,
  InstallmentScheduleItem,
  OriginateLoanDTO,
  OffRampAttestation,
  ExchangeRate,
  ChainLoanDraft,
  DisbursementResult,
  DisbursementStatus,
} from "../types";
import type { ChainLoan } from "../chain/soroban";
import { activeChain, activePartnerSigner } from "../chain/runtime";
import {
  loans,
  beneficiaries,
  repaymentAttestations,
  guarantorToVault,
  vaults,
  generateId,
} from "../stores";
import { OffRampAdapter } from "../adapters/offramp.interface";
import { withDisbursementTimeout, DisbursementTimeoutError } from "../adapters/with-timeout";
import { ContractGateway } from "../contracts/gateway.interface";
import { logAuditEvent } from "./audit.service";
import * as vaultService from "./vault.service";
import * as notifications from "./notification.service";
import { computeAdjustedLtv, refreshReputationScore } from "./reputation.service";
import { applyChainState } from "./loan-chain.service";

// ─── Module-level adapter references ─────────────────────────────────

let offRampAdapter: OffRampAdapter;
let contractGateway: ContractGateway | undefined;

export function setOffRampAdapter(adapter: OffRampAdapter): void {
  offRampAdapter = adapter;
}

export function setContractGateway(gateway: ContractGateway): void {
  contractGateway = gateway;
}

// ─── Exchange Rates ──────────────────────────────────────────────────

/**
 * The off-ramp partner's current rate for a currency. Loans are priced at the
 * rate the partner will actually disburse at, not an outside reference rate.
 */
export async function quoteExchangeRate(localCurrency: string): Promise<ExchangeRate> {
  if (!offRampAdapter) throw new Error("No off-ramp partner is configured to price loans");
  const quote = await offRampAdapter.getExchangeRate(localCurrency);
  if (!Number.isFinite(quote.local_per_usd) || quote.local_per_usd <= 0) {
    throw new Error(`The off-ramp partner quoted an invalid rate for ${localCurrency}`);
  }
  return quote;
}

// ─── Loan Origination (§3.2) ─────────────────────────────────────────

export async function originateLoan(
  guarantorId: string,
  dto: OriginateLoanDTO,
): Promise<Loan> {
  const beneficiary = beneficiaries.get(dto.beneficiaryId);
  if (!beneficiary) throw new Error(`Beneficiary ${dto.beneficiaryId} not found`);

  const vaultId = guarantorToVault.get(guarantorId);
  if (!vaultId) throw new Error("No vault found. Deposit collateral first.");

  const vault = vaults.get(vaultId);
  if (!vault) throw new Error("Vault not found");

  // Check for existing active loan for this beneficiary from this guarantor
  const existingLoan = Array.from(loans.values()).find(
    (l) =>
      l.guarantorId === guarantorId &&
      l.beneficiaryId === dto.beneficiaryId &&
      (l.status === "active" || l.status === "grace"),
  );
  if (existingLoan) {
    throw new Error("An active loan already exists for this beneficiary");
  }

  // Compute LTV from reputation (§8.3)
  const ltvRatio = computeAdjustedLtv(dto.beneficiaryId);

  // Price the loan at the partner's rate: the USD value the partner will
  // actually pay out is what the collateral has to cover. The rate is kept on
  // the loan, so every installment and every release is measured against it
  // for the loan's whole life, however the market moves afterwards.
  const { local_per_usd: fxRate } = await quoteExchangeRate(dto.localCurrency);
  const principalUsd = Math.round((dto.principalLocal / fxRate) * 100) / 100;
  if (principalUsd <= 0) throw new Error("The principal is too small to price in USD");

  // Required collateral = principal * LTV ratio
  const requiredCollateral = Math.round(principalUsd * ltvRatio * 100) / 100;
  const available = vault.collateralBalance - vault.lockedAmount;

  if (available < requiredCollateral) {
    throw new Error(
      `Insufficient collateral. Required: ${requiredCollateral} USDC ` +
      `(${principalUsd} × ${ltvRatio} LTV), available: ${available} USDC`,
    );
  }

  // Generate installment schedule
  const intervalDays = dto.installmentIntervalDays || 30;
  const schedule = generateInstallmentSchedule(
    dto.principalLocal,
    principalUsd,
    dto.installmentCount,
    intervalDays,
  );

  // Create loan record
  const loan: Loan = {
    id: generateId(),
    vaultId,
    beneficiaryId: dto.beneficiaryId,
    guarantorId,
    principalLocal: dto.principalLocal,
    principalUsd,
    localCurrency: dto.localCurrency,
    ltvRatio,
    fxRate,
    collateralLockedUsd: requiredCollateral,
    collateralReleasedUsd: 0,
    collateralForfeitedUsd: 0,
    installmentCount: dto.installmentCount,
    installmentIntervalDays: intervalDays,
    schedule,
    status: "active",
    purpose: dto.purpose,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Lock collateral, on chain first so a contract rejection stops the loan
  // before any local state claims the collateral is spoken for.
  if (contractGateway) {
    const locked = await contractGateway.lockCollateral(
      vaultId,
      loan.id,
      requiredCollateral,
    );
    if (!locked.success) {
      throw new Error(`Could not lock collateral: ${locked.failureReason}`);
    }
  }

  vaultService.lockCollateral(vaultId, requiredCollateral);

  // Persist the loan
  loans.set(loan.id, loan);

  if (contractGateway) {
    await contractGateway.recordLoan(loan.id, vaultId, principalUsd, ltvRatio);
  }

  // Disburse via off-ramp adapter
  if (offRampAdapter) {
    try {
      await withDisbursementTimeout(
        offRampAdapter.disburse({
          loan_id: loan.id,
          beneficiary_phone: beneficiary.phoneNumber,
          beneficiary_kyc_ref: beneficiary.localKycRef,
          amount_local: dto.principalLocal,
          local_currency: dto.localCurrency,
          idempotency_key: loan.id,
        }),
        config.disbursementTimeoutMs,
      );
      loan.disbursementStatus = "completed";
      loan.updatedAt = new Date().toISOString();
      loans.set(loan.id, loan);
      // §3.2 step 5 — the beneficiary has no wallet and no dashboard, so
      // the SMS is the only way they learn the schedule they must repay on.
      notifications.notifyLoanDisbursed(loan, beneficiary);
    } catch (err) {
      // A timeout means the partner's own answer never arrived -- they may
      // already have paid the beneficiary. Rolling back here regardless
      // would be the thing #32 exists to prevent: the loan and its locked
      // collateral are left exactly as they are, flagged for an operator
      // to resolve once the partner's actual status is known, rather than
      // guessed at.
      if (err instanceof DisbursementTimeoutError) {
        loan.disbursementStatus = "unknown";
        loan.updatedAt = new Date().toISOString();
        loans.set(loan.id, loan);
        logAuditEvent({
          eventType: "LOAN",
          action: "LOAN_DISBURSEMENT_UNKNOWN",
          actor: guarantorId,
          entityType: "loan",
          entityId: loan.id,
          details: { message: err.message },
        });
        throw new Error(`Disbursement outcome unknown: ${err.message}`);
      }

      // A clean rejection, by contrast, is certain: nothing was disbursed,
      // so unwinding the on-chain lock as well as the local one is safe --
      // otherwise the guarantor's collateral stays locked against a loan
      // that never existed.
      if (contractGateway) {
        await contractGateway.releaseCollateral(vaultId, loan.id, requiredCollateral);
        await contractGateway.closeLoan(loan.id, "defaulted");
      }
      vaultService.releaseCollateral(vaultId, requiredCollateral);
      loans.delete(loan.id);
      throw new Error(`Disbursement failed: ${(err as Error).message}`);
    }
  }

  logAuditEvent({
    eventType: "LOAN",
    action: "LOAN_ORIGINATED",
    actor: guarantorId,
    entityType: "loan",
    entityId: loan.id,
    details: {
      beneficiaryId: dto.beneficiaryId,
      principalLocal: dto.principalLocal,
      localCurrency: dto.localCurrency,
      fxRate,
      principalUsd,
      ltvRatio,
      collateralLocked: requiredCollateral,
    },
  });

  return loan;
}

// ─── Origination on chain ────────────────────────────────────────────

/**
 * Price a loan for origination on chain, before the guarantor signs. The same
 * checks and pricing as originateLoan, without touching any collateral: on
 * chain, the ledger locks it when the guarantor's signed transaction lands.
 */
export async function draftChainLoan(guarantorId: string, dto: OriginateLoanDTO): Promise<ChainLoanDraft> {
  const beneficiary = beneficiaries.get(dto.beneficiaryId);
  if (!beneficiary) throw new Error(`Beneficiary ${dto.beneficiaryId} not found`);

  const open = Array.from(loans.values()).find(
    (l) =>
      l.guarantorId === guarantorId &&
      l.beneficiaryId === dto.beneficiaryId &&
      (l.status === "active" || l.status === "grace"),
  );
  if (open) throw new Error("An active loan already exists for this beneficiary");

  const { local_per_usd: fxRate } = await quoteExchangeRate(dto.localCurrency);
  const principalUsd = Math.round((dto.principalLocal / fxRate) * 100) / 100;
  if (principalUsd <= 0) throw new Error("The principal is too small to price in USD");

  return {
    beneficiaryId: dto.beneficiaryId,
    principalLocal: dto.principalLocal,
    localCurrency: dto.localCurrency,
    installmentCount: dto.installmentCount,
    intervalDays: dto.installmentIntervalDays || 30,
    purpose: dto.purpose,
    fxRate,
    principalUsd,
    ltvRatio: computeAdjustedLtv(dto.beneficiaryId),
  };
}

/**
 * Record a loan the guarantor has originated on chain, and have the partner
 * disburse it. Principal, LTV and the collateral locked are taken from the
 * chain, which is where the collateral actually sits.
 *
 * A failed disbursement cannot be unwound here: the collateral is already
 * locked on chain, and the contracts have no way to cancel an undisbursed
 * loan yet. It is recorded and audited so it can be resolved, not hidden.
 */
export async function recordChainLoan(
  guarantorId: string,
  draft: ChainLoanDraft,
  onChain: ChainLoan,
): Promise<Loan> {
  const beneficiary = beneficiaries.get(draft.beneficiaryId);
  if (!beneficiary) throw new Error(`Beneficiary ${draft.beneficiaryId} not found`);

  const now = new Date().toISOString();
  const loan: Loan = {
    id: generateId(),
    vaultId: vaultService.getOrCreateVault(guarantorId).id,
    beneficiaryId: draft.beneficiaryId,
    guarantorId,
    principalLocal: draft.principalLocal,
    principalUsd: onChain.principalUsd,
    localCurrency: draft.localCurrency,
    ltvRatio: onChain.ltvBps / 10_000,
    fxRate: draft.fxRate,
    collateralLockedUsd: onChain.collateralLockedUsd,
    collateralReleasedUsd: onChain.collateralReleasedUsd,
    collateralForfeitedUsd: 0,
    installmentCount: draft.installmentCount,
    installmentIntervalDays: draft.intervalDays,
    schedule: generateInstallmentSchedule(
      draft.principalLocal,
      onChain.principalUsd,
      draft.installmentCount,
      draft.intervalDays,
      onChain.originatedAt,
    ),
    status: "active",
    purpose: draft.purpose,
    chainLoanId: onChain.id.toString(),
    createdAt: now,
    updatedAt: now,
  };
  loans.set(loan.id, loan);

  logAuditEvent({
    eventType: "LOAN",
    action: "LOAN_ORIGINATED",
    actor: guarantorId,
    entityType: "loan",
    entityId: loan.id,
    details: {
      chainLoanId: loan.chainLoanId,
      beneficiaryId: draft.beneficiaryId,
      principalLocal: draft.principalLocal,
      localCurrency: draft.localCurrency,
      fxRate: draft.fxRate,
      principalUsd: loan.principalUsd,
      ltvRatio: loan.ltvRatio,
      collateralLocked: loan.collateralLockedUsd,
    },
  });

  if (offRampAdapter) {
    try {
      await withDisbursementTimeout(
        offRampAdapter.disburse({
          loan_id: loan.id,
          beneficiary_phone: beneficiary.phoneNumber,
          beneficiary_kyc_ref: beneficiary.localKycRef,
          amount_local: draft.principalLocal,
          local_currency: draft.localCurrency,
          idempotency_key: loan.id,
        }),
        config.disbursementTimeoutMs,
      );
      loan.disbursementStatus = "completed";
      loan.updatedAt = new Date().toISOString();
      loans.set(loan.id, loan);
      notifications.notifyLoanDisbursed(loan, beneficiary);
    } catch (err) {
      loan.disbursementStatus = err instanceof DisbursementTimeoutError ? "unknown" : "failed";
      loan.updatedAt = new Date().toISOString();
      loans.set(loan.id, loan);
      // Distinct from a clean rejection: the partner's own answer never
      // arrived, so whether the beneficiary was actually paid is unknown,
      // not "no". Either way nothing can be unwound here -- the collateral
      // is already locked on chain -- but an operator resolving this needs
      // to know which case they're looking at.
      logAuditEvent({
        eventType: "LOAN",
        action: err instanceof DisbursementTimeoutError ? "LOAN_DISBURSEMENT_UNKNOWN" : "LOAN_DISBURSEMENT_FAILED",
        actor: guarantorId,
        entityType: "loan",
        entityId: loan.id,
        details: { chainLoanId: loan.chainLoanId, message: (err as Error).message },
      });
    }
  }

  return loan;
}

// ─── Repayment Attestation (§3.3) ────────────────────────────────────

export async function processRepaymentAttestation(
  attestation: OffRampAttestation,
  attestedBy: string,
): Promise<{ loan: Loan; collateralReleased: number }> {
  const loan = loans.get(attestation.loan_id);
  if (!loan) throw new Error(`Loan ${attestation.loan_id} not found`);

  // Idempotent per (loan, installment): a partner retrying after a timeout
  // it never saw a response for must not re-release collateral, duplicate
  // the audit trail, or call the contract gateway a second time. This also
  // means a retry of a loan's *last* installment, submitted after the loan
  // has already moved to "repaid", is recognized as a replay rather than
  // hitting the status guard below with a confusing error.
  const alreadyAttested = repaymentAttestations.some(
    (a) => a.loanId === attestation.loan_id && a.installmentNumber === attestation.installment_number,
  );
  if (alreadyAttested) {
    return { loan, collateralReleased: 0 };
  }

  if (loan.status !== "active" && loan.status !== "grace") {
    throw new Error(`Cannot process repayment for loan with status: ${loan.status}`);
  }

  // The attestation must describe an installment this loan actually has, for
  // the amount that installment is for. A genuine partner signature over the
  // wrong figures would otherwise still release collateral.
  const scheduled = loan.schedule.find((s) => s.installmentNumber === attestation.installment_number);
  if (!scheduled) {
    throw new Error(`Loan ${loan.id} has no installment ${attestation.installment_number}`);
  }
  if (scheduled.status === "repaid") {
    return { loan, collateralReleased: 0 };
  }
  if (
    Math.abs(attestation.amount_usd - scheduled.amountUsd) > ATTESTATION_TOLERANCE ||
    Math.abs(attestation.amount_local - scheduled.amountLocal) > ATTESTATION_TOLERANCE
  ) {
    throw new Error(
      `Attested amount does not match installment ${scheduled.installmentNumber}: ` +
        `expected ${scheduled.amountLocal} ${loan.localCurrency} (${scheduled.amountUsd} USD)`,
    );
  }

  // Verify attestation signature via adapter
  if (offRampAdapter) {
    const valid = await offRampAdapter.verifyAttestation(attestation);
    if (!valid) throw new Error("Invalid attestation signature");
  }

  // With the contracts connected, the attestation is settled on chain first:
  // the ledger decides what is released, and the backend records the result.
  const chain = activeChain();
  if (chain && loan.chainLoanId) {
    return processChainAttestation(chain, loan, attestation, attestedBy);
  }

  // Record the attestation
  const record = {
    id: generateId(),
    loanId: attestation.loan_id,
    installmentNumber: attestation.installment_number,
    amountLocal: attestation.amount_local,
    amountUsd: attestation.amount_usd,
    attestedBy,
    partnerSignature: attestation.partner_signature,
    attestedAt: attestation.attested_at,
    createdAt: new Date().toISOString(),
  };
  repaymentAttestations.push(record);

  // Update schedule
  const scheduleItem = loan.schedule.find(
    (s) => s.installmentNumber === attestation.installment_number,
  );
  if (scheduleItem) {
    scheduleItem.status = "repaid";
    scheduleItem.repaidAt = attestation.attested_at;
  }

  // Compute collateral release (§3.4)
  const allRepaid = loan.schedule.every((s) => s.status === "repaid");

  // On full repayment the safety buffer is released too, so the release is
  // whatever is still locked rather than the pro-rata increment.
  const collateralReleased = allRepaid
    ? outstandingCollateral(loan)
    : computeCollateralRelease(loan);

  if (contractGateway) {
    await contractGateway.recordRepayment(
      loan.id,
      attestation.installment_number,
      attestation.amount_usd,
    );
  }

  if (collateralReleased > 0) {
    if (contractGateway) {
      const released = await contractGateway.releaseCollateral(
        loan.vaultId,
        loan.id,
        collateralReleased,
      );
      if (!released.success) {
        throw new Error(`Could not release collateral: ${released.failureReason}`);
      }
    }

    vaultService.releaseCollateral(loan.vaultId, collateralReleased);
    loan.collateralReleasedUsd =
      Math.round((loan.collateralReleasedUsd + collateralReleased) * 100) / 100;
  }

  if (allRepaid) {
    loan.status = "repaid";
    loan.graceExpiresAt = undefined;
  } else if (loan.status === "grace") {
    // A payment during the grace period pulls the loan back to active, but
    // only once no installment is still sitting overdue.
    const stillOverdue = loan.schedule.some((s) => s.status === "overdue");
    if (!stillOverdue) {
      loan.status = "active";
      loan.graceExpiresAt = undefined;
    }
  }

  loan.updatedAt = new Date().toISOString();
  loans.set(loan.id, loan);

  if (allRepaid && contractGateway) {
    await contractGateway.closeLoan(loan.id, "repaid");
  }

  // Update beneficiary reputation (§8.4)
  refreshReputationScore(loan.beneficiaryId);

  if (allRepaid) {
    const beneficiary = beneficiaries.get(loan.beneficiaryId);
    if (beneficiary) {
      notifications.notifyLoanRepaid(loan, beneficiary);
    }
  }

  logAuditEvent({
    eventType: "REPAYMENT",
    action: "ATTESTATION_PROCESSED",
    entityType: "loan",
    entityId: loan.id,
    details: {
      installmentNumber: attestation.installment_number,
      amountLocal: attestation.amount_local,
      amountUsd: attestation.amount_usd,
      collateralReleased,
      loanStatus: loan.status,
    },
  });

  return { loan, collateralReleased };
}

/** How far an attested amount may be from the scheduled one: rounding to the cent. */
const ATTESTATION_TOLERANCE = 0.011;

/**
 * Settle a repayment attestation on chain, then record what the chain did.
 *
 * The chain is asked what it has already applied before anything is sent, so
 * a retry after a crash between "the chain accepted it" and "the backend
 * recorded it" records the repayment rather than sending it twice. The amount
 * sent is whatever brings the loan's cumulative repayment to the end of the
 * installment, to the cent: the ledger counts installments from principal
 * repaid, so equal cent-rounded installments would leave it short of the last.
 */
async function processChainAttestation(
  chain: NonNullable<ReturnType<typeof activeChain>>,
  loan: Loan,
  attestation: OffRampAttestation,
  attestedBy: string,
): Promise<{ loan: Loan; collateralReleased: number }> {
  const signPartner = activePartnerSigner();
  if (!signPartner) {
    throw new Error("This deployment cannot co-sign a repayment for the partner, so it cannot settle one on chain");
  }

  const loanId = BigInt(loan.chainLoanId!);
  let onChain = await chain.loan(loanId);
  if (!onChain) throw new Error(`Loan ${loan.chainLoanId} is not on chain`);
  if (onChain.status !== "active" && onChain.status !== "grace") {
    throw new Error(`Cannot process repayment for loan with status: ${onChain.status}`);
  }

  const n = attestation.installment_number;
  let collateralReleased = 0;
  let txHash: string | undefined;

  if (onChain.installmentsPaid >= n) {
    // The chain already counts this installment as paid.
    logger.warn({ loanId: loan.id, installment: n }, "attestation was already applied on chain, recording it");
  } else {
    if (n !== onChain.installmentsPaid + 1) {
      throw new Error(`Installment ${onChain.installmentsPaid + 1} must be repaid before installment ${n}`);
    }
    const principalCents = BigInt(Math.round(onChain.principalUsd * 100));
    const repaidCents = BigInt(Math.round(onChain.totalRepaidUsd * 100));
    const targetCents = (principalCents * BigInt(n) + BigInt(onChain.installmentCount) - 1n) / BigInt(onChain.installmentCount);
    const amount = Number(targetCents - repaidCents) / 100;
    if (Math.abs(amount - attestation.amount_usd) > ATTESTATION_TOLERANCE) {
      throw new Error(`The ledger expects ${amount} USD for installment ${n}, not ${attestation.amount_usd}`);
    }

    const result = await chain.attestRepayment({
      partner: onChain.partner,
      loanId,
      amountUsd: amount,
      signPartnerAuthEntry: signPartner,
    });
    collateralReleased = result.releasedUsd;
    txHash = result.hash;
  }

  repaymentAttestations.push({
    id: generateId(),
    loanId: attestation.loan_id,
    installmentNumber: n,
    amountLocal: attestation.amount_local,
    amountUsd: attestation.amount_usd,
    attestedBy,
    partnerSignature: attestation.partner_signature,
    attestedAt: attestation.attested_at,
    createdAt: new Date().toISOString(),
  });

  // The backend's loan now follows the chain's, not its own arithmetic.
  onChain = (await chain.loan(loanId)) ?? onChain;
  applyChainState(loan, onChain, attestation.attested_at);

  refreshReputationScore(loan.beneficiaryId);
  if (loan.status === "repaid") {
    const beneficiary = beneficiaries.get(loan.beneficiaryId);
    if (beneficiary) notifications.notifyLoanRepaid(loan, beneficiary);
  }

  logAuditEvent({
    eventType: "REPAYMENT",
    action: "ATTESTATION_PROCESSED",
    entityType: "loan",
    entityId: loan.id,
    details: {
      installmentNumber: n,
      amountLocal: attestation.amount_local,
      amountUsd: attestation.amount_usd,
      collateralReleased,
      loanStatus: loan.status,
      chainLoanId: loan.chainLoanId,
      txHash,
    },
  });

  return { loan, collateralReleased };
}

// ─── Schedule Generation ─────────────────────────────────────────────

function generateInstallmentSchedule(
  principalLocal: number,
  principalUsd: number,
  count: number,
  intervalDays: number,
  start: Date = new Date(),
): InstallmentScheduleItem[] {
  const amountLocal = Math.round((principalLocal / count) * 100) / 100;
  const amountUsd = Math.round((principalUsd / count) * 100) / 100;
  const schedule: InstallmentScheduleItem[] = [];

  for (let i = 1; i <= count; i++) {
    const dueDate = new Date(start);
    dueDate.setDate(dueDate.getDate() + intervalDays * i);

    schedule.push({
      installmentNumber: i,
      amountLocal: i === count ? principalLocal - amountLocal * (count - 1) : amountLocal,
      amountUsd: i === count ? principalUsd - amountUsd * (count - 1) : amountUsd,
      dueAt: dueDate.toISOString(),
      status: "pending",
    });
  }

  return schedule;
}

// ─── Collateral Release Calculation (§3.4) ───────────────────────────

/**
 * released_ratio = (total_repaid / total_principal) * (1 - safety_buffer)
 *
 * The ratio is cumulative, so the incremental release is measured against
 * what this loan has already released. That figure is tracked on the loan
 * itself rather than derived from the vault's locked balance: a vault backs
 * one loan per beneficiary and may back several at once, so vault.lockedAmount
 * is the sum across all of them and cannot attribute a release to one loan.
 */
export function computeCollateralRelease(loan: Loan): number {
  const totalRepaid = loan.schedule
    .filter((s) => s.status === "repaid")
    .reduce((sum, s) => sum + s.amountUsd, 0);

  const releasedRatio =
    (totalRepaid / loan.principalUsd) * (1 - config.protocol.safetyBufferRatio);

  const shouldBeReleased = loan.collateralLockedUsd * releasedRatio;
  const incrementalRelease = Math.max(0, shouldBeReleased - loan.collateralReleasedUsd);

  return Math.round(incrementalRelease * 100) / 100;
}

/** Collateral still locked against this loan. */
export function outstandingCollateral(loan: Loan): number {
  const remaining =
    loan.collateralLockedUsd - loan.collateralReleasedUsd - loan.collateralForfeitedUsd;
  return Math.max(0, Math.round(remaining * 100) / 100);
}

/** Principal still owed on this loan, in USD. */
export function outstandingPrincipal(loan: Loan): number {
  const repaid = loan.schedule
    .filter((s) => s.status === "repaid")
    .reduce((sum, s) => sum + s.amountUsd, 0);
  return Math.max(0, Math.round((loan.principalUsd - repaid) * 100) / 100);
}

// ─── Disbursement Reconciliation ────────────────────────────────────

export interface ReconcileDisbursementOptions {
  success?: boolean;
  partnerReference?: string;
  failureReason?: string;
}

export interface ReconcileDisbursementResult {
  success: boolean;
  outcome: "disbursed" | "unwound";
  loan?: Loan;
  partnerReference?: string;
  failureReason?: string;
}

/**
 * Reconcile a loan whose disbursement timed out or left the outcome unknown.
 *
 * Checks against the off-ramp partner (via getDisbursementStatus) or applies
 * an operator-provided resolution:
 * - If the partner disbursed: confirms the loan as completed, sends notification,
 *   and keeps collateral locked.
 * - If the partner rejected / failed: unwinds the locked collateral back to the
 *   vault (and on chain if gateway connected) and cleans up the loan.
 */
export async function reconcileDisbursement(
  loanId: string,
  resolution?: ReconcileDisbursementOptions,
  actor = "system",
): Promise<ReconcileDisbursementResult> {
  const loan = loans.get(loanId);
  if (!loan) {
    throw new Error(`Loan ${loanId} not found`);
  }

  let result: DisbursementResult;
  if (resolution !== undefined && typeof resolution.success === "boolean") {
    result = {
      success: resolution.success,
      partner_reference: resolution.partnerReference ?? `MANUAL-${Date.now()}`,
      disbursed_at: new Date().toISOString(),
      failure_reason: resolution.failureReason,
    };
  } else {
    if (!offRampAdapter) {
      throw new Error("No off-ramp adapter configured for reconciliation");
    }
    result = await offRampAdapter.getDisbursementStatus(loan.id);
  }

  if (result.success) {
    loan.disbursementStatus = "completed";
    loan.updatedAt = new Date().toISOString();
    loans.set(loan.id, loan);

    const beneficiary = beneficiaries.get(loan.beneficiaryId);
    if (beneficiary) {
      notifications.notifyLoanDisbursed(loan, beneficiary);
    }

    logAuditEvent({
      eventType: "LOAN",
      action: "LOAN_DISBURSEMENT_RECONCILED",
      actor,
      entityType: "loan",
      entityId: loan.id,
      details: {
        outcome: "disbursed",
        partnerReference: result.partner_reference,
      },
    });

    return {
      success: true,
      outcome: "disbursed",
      loan,
      partnerReference: result.partner_reference,
    };
  } else {
    if (contractGateway) {
      await contractGateway.releaseCollateral(loan.vaultId, loan.id, loan.collateralLockedUsd);
      await contractGateway.closeLoan(loan.id, "defaulted");
    }
    vaultService.releaseCollateral(loan.vaultId, loan.collateralLockedUsd);
    loans.delete(loan.id);

    logAuditEvent({
      eventType: "LOAN",
      action: "LOAN_DISBURSEMENT_RECONCILED",
      actor,
      entityType: "loan",
      entityId: loan.id,
      details: {
        outcome: "unwound",
        failureReason: result.failure_reason ?? "Partner confirmed non-disbursement",
      },
    });

    return {
      success: true,
      outcome: "unwound",
      failureReason: result.failure_reason,
    };
  }
}

/** Lists all loans whose disbursement outcome is currently unknown. */
export function loansWithUnknownDisbursement(): Loan[] {
  return Array.from(loans.values()).filter((l) => l.disbursementStatus === "unknown");
}

