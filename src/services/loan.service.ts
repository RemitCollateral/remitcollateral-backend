import { config } from "../config";
import {
  Loan,
  InstallmentScheduleItem,
  OriginateLoanDTO,
  OffRampAttestation,
} from "../types";
import {
  loans,
  beneficiaries,
  repaymentAttestations,
  guarantorToVault,
  vaults,
  generateId,
} from "../stores";
import { OffRampAdapter } from "../adapters/offramp.interface";
import { ContractGateway } from "../contracts/gateway.interface";
import { logAuditEvent } from "./audit.service";
import * as vaultService from "./vault.service";
import * as notifications from "./notification.service";
import { computeAdjustedLtv, refreshReputationScore } from "./reputation.service";

// ─── Module-level adapter references ─────────────────────────────────

let offRampAdapter: OffRampAdapter;
let contractGateway: ContractGateway | undefined;

export function setOffRampAdapter(adapter: OffRampAdapter): void {
  offRampAdapter = adapter;
}

export function setContractGateway(gateway: ContractGateway): void {
  contractGateway = gateway;
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

  // Convert principal to USD equivalent (simplified: 1:1 for USDC-denominated)
  // In production, this would use an FX rate oracle
  const principalUsd = dto.principalLocal; // Simplified for v1

  // Required collateral = principal * LTV ratio
  const requiredCollateral = principalUsd * ltvRatio;
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
      await offRampAdapter.disburse({
        loan_id: loan.id,
        beneficiary_phone: beneficiary.phoneNumber,
        beneficiary_kyc_ref: beneficiary.localKycRef,
        amount_local: dto.principalLocal,
        local_currency: dto.localCurrency,
        idempotency_key: loan.id,
      });
      // §3.2 step 5 — the beneficiary has no wallet and no dashboard, so
      // the SMS is the only way they learn the schedule they must repay on.
      notifications.notifyLoanDisbursed(loan, beneficiary);
    } catch (err) {
      // Rollback: unwind the on-chain lock as well as the local one, or the
      // guarantor's collateral stays locked against a loan that never existed.
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
      ltvRatio,
      collateralLocked: requiredCollateral,
    },
  });

  return loan;
}

// ─── Repayment Attestation (§3.3) ────────────────────────────────────

export async function processRepaymentAttestation(
  attestation: OffRampAttestation,
  attestedBy: string,
): Promise<{ loan: Loan; collateralReleased: number }> {
  const loan = loans.get(attestation.loan_id);
  if (!loan) throw new Error(`Loan ${attestation.loan_id} not found`);

  if (loan.status !== "active" && loan.status !== "grace") {
    throw new Error(`Cannot process repayment for loan with status: ${loan.status}`);
  }

  // Verify attestation signature via adapter
  if (offRampAdapter) {
    const valid = await offRampAdapter.verifyAttestation(attestation);
    if (!valid) throw new Error("Invalid attestation signature");
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

// ─── Schedule Generation ─────────────────────────────────────────────

function generateInstallmentSchedule(
  principalLocal: number,
  principalUsd: number,
  count: number,
  intervalDays: number,
): InstallmentScheduleItem[] {
  const amountLocal = Math.round((principalLocal / count) * 100) / 100;
  const amountUsd = Math.round((principalUsd / count) * 100) / 100;
  const schedule: InstallmentScheduleItem[] = [];

  const now = new Date();
  for (let i = 1; i <= count; i++) {
    const dueDate = new Date(now);
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
