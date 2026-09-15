/**
 * The API's wire format.
 *
 * Every response the frontend reads is built here, from the domain models, in
 * the snake_case shapes declared by the frontend's `lib/types.ts`. Keeping the
 * mapping in one place means the contract is written down once, and tested,
 * rather than being whatever each route happens to return.
 */
import { config } from "../config";
import {
  Beneficiary,
  BeneficiaryLink,
  Guarantor,
  InstallmentScheduleItem,
  Loan,
  RemittanceRecord,
  RepaymentAttestation,
  Vault,
} from "../types";
import { outstandingCollateral } from "../services/loan.service";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Scores are kept 0–100 internally; the API reports them on a 0–1 scale. */
const unitScore = (score: number) => round2(Math.min(100, Math.max(0, score)) / 100);

export function serializeGuarantor(guarantor: Guarantor) {
  return {
    id: guarantor.id,
    wallet_address: guarantor.walletAddress,
    display_name: guarantor.displayName ?? null,
    created_at: guarantor.createdAt,
  };
}

export function serializeVault(vault: Vault) {
  return {
    id: vault.id,
    guarantor_id: vault.guarantorId,
    collateral_balance: round2(vault.collateralBalance),
    locked_amount: round2(vault.lockedAmount),
    available_amount: round2(vault.collateralBalance - vault.lockedAmount),
    created_at: vault.createdAt,
  };
}

/**
 * A beneficiary as one guarantor sees them: with that guarantor's own name for
 * them, and the date that guarantor added them.
 */
export function serializeBeneficiary(beneficiary: Beneficiary, link?: BeneficiaryLink) {
  return {
    id: beneficiary.id,
    phone_number: beneficiary.phoneNumber,
    local_kyc_ref: beneficiary.localKycRef || null,
    reputation_score: unitScore(beneficiary.reputationScore),
    display_name: link?.displayName ?? null,
    local_currency: beneficiary.localCurrency,
    created_at: link?.createdAt ?? beneficiary.createdAt,
  };
}

export type ScheduleStatus = "paid" | "due" | "upcoming" | "overdue";
export type ScheduleEntry = ReturnType<typeof serializeSchedule>[number];

/**
 * Installments with their status against the clock: unpaid past the due date
 * is overdue, the soonest unpaid future installment is due, and later ones are
 * upcoming. Derived on read, so it never lags the lifecycle sweep that writes
 * the stored status.
 */
export function serializeSchedule(schedule: InstallmentScheduleItem[], now = Date.now()) {
  let dueSeen = false;
  return [...schedule]
    .sort((a, b) => a.installmentNumber - b.installmentNumber)
    .map((item) => {
      let status: ScheduleStatus;
      if (item.status === "repaid") status = "paid";
      else if (item.status === "overdue" || new Date(item.dueAt).getTime() < now) status = "overdue";
      else if (!dueSeen) {
        dueSeen = true;
        status = "due";
      } else status = "upcoming";

      return {
        installment: item.installmentNumber,
        amount_local: item.amountLocal,
        due_at: item.dueAt,
        paid_at: item.status === "repaid" ? (item.repaidAt ?? null) : null,
        status,
      };
    });
}

export function serializeLoan(loan: Loan, now = Date.now()) {
  return {
    id: loan.id,
    vault_id: loan.vaultId,
    beneficiary_id: loan.beneficiaryId,
    principal_local: loan.principalLocal,
    principal_usd: loan.principalUsd,
    local_currency: loan.localCurrency,
    ltv_ratio: loan.ltvRatio,
    installment_count: loan.installmentCount,
    schedule: serializeSchedule(loan.schedule, now),
    status: loan.status,
    grace_expires_at: loan.graceExpiresAt ?? null,
    purpose: loan.purpose ?? null,
    created_at: loan.createdAt,
    updated_at: loan.updatedAt,
  };
}

/** A loan joined with its beneficiary and the figures the dashboard shows beside it. */
export function serializeLoanWithBeneficiary(
  loan: Loan,
  beneficiary: Beneficiary,
  link?: BeneficiaryLink,
  now = Date.now(),
) {
  const base = serializeLoan(loan, now);
  const totalRepaidLocal = loan.schedule
    .filter((item) => item.status === "repaid")
    .reduce((sum, item) => sum + item.amountLocal, 0);

  return {
    ...base,
    beneficiary: serializeBeneficiary(beneficiary, link),
    total_repaid_local: round2(totalRepaidLocal),
    outstanding_local: round2(loan.principalLocal - totalRepaidLocal),
    // Locked now, not at origination: zero once the loan has settled.
    collateral_locked_usd: outstandingCollateral(loan),
    collateral_released_usd: round2(loan.collateralReleasedUsd),
    next_installment: base.schedule.find((entry) => entry.status !== "paid") ?? null,
    missed_installments: base.schedule.filter((entry) => entry.status === "overdue").length,
  };
}

export type LoanView = ReturnType<typeof serializeLoanWithBeneficiary>;

export function serializeAttestation(attestation: RepaymentAttestation) {
  return {
    id: attestation.id,
    loan_id: attestation.loanId,
    installment_number: attestation.installmentNumber,
    amount_local: attestation.amountLocal,
    amount_usd: attestation.amountUsd,
    attested_by: attestation.attestedBy,
    attested_at: attestation.attestedAt,
    created_at: attestation.createdAt,
  };
}

export function serializeRemittance(record: RemittanceRecord) {
  return {
    id: record.id,
    guarantor_id: record.guarantorId,
    beneficiary_id: record.beneficiaryId,
    amount_usd: record.amountUsd,
    local_amount: record.localAmount,
    local_currency: record.localCurrency,
    source: record.source,
    sent_at: record.sentAt,
    created_at: record.createdAt,
  };
}

export interface ReputationFacts {
  compositeScore: number;
  remittanceScore: number;
  repaymentScore: number;
  adjustedLtv: number;
  historyMonths: number;
  loansCompleted: number;
  loansDefaulted: number;
}

export function serializeReputation(beneficiaryId: string, facts: ReputationFacts) {
  return {
    beneficiary_id: beneficiaryId,
    composite_score: unitScore(facts.compositeScore),
    remittance_score: unitScore(facts.remittanceScore),
    repayment_score: unitScore(facts.repaymentScore),
    remittance_months_observed: Math.floor(facts.historyMonths),
    remittance_meets_minimum_history: facts.historyMonths >= config.protocol.minRemittanceMonths,
    // The repayment score is itself the percentage of installments paid on time.
    on_time_repayment_rate: unitScore(facts.repaymentScore),
    loans_completed: facts.loansCompleted,
    loans_defaulted: facts.loansDefaulted,
    qualified_ltv: facts.adjustedLtv,
  };
}
