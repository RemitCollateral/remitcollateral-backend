// ─── Domain Models & Entities ────────────────────────────────────────

export interface Guarantor {
  id: string;
  walletAddress: string;
  displayName?: string;
  createdAt: string;
}

export interface Vault {
  id: string;
  guarantorId: string;
  collateralBalance: number; // total USDC deposited
  lockedAmount: number;       // portion currently backing active loans
  createdAt: string;
}

export interface Beneficiary {
  id: string;
  phoneNumber: string;
  localKycRef: string;
  reputationScore: number;    // composite score (0 to 100)
  localCurrency: string;      // ISO 4217, the currency loans to them are made in
  createdAt: string;
}

/**
 * A guarantor's link to a beneficiary they support. A beneficiary is one
 * person, identified by phone number and the partner's KYC reference, and may
 * be supported by several guarantors, each keeping their own name for them.
 */
export interface BeneficiaryLink {
  guarantorId: string;
  beneficiaryId: string;
  displayName?: string;
  createdAt: string;
}

export type RemittanceSource = "partner_reported" | "self_declared";

export interface RemittanceRecord {
  id: string;
  guarantorId: string;
  beneficiaryId: string;
  amountUsd: number;
  localAmount: number;
  localCurrency: string;       // e.g. "NGN"
  source: RemittanceSource;
  sentAt: string;
  createdAt: string;
}

export type LoanStatus = "active" | "grace" | "repaid" | "defaulted";

export interface InstallmentScheduleItem {
  installmentNumber: number;
  amountLocal: number;
  amountUsd: number;
  dueAt: string;
  status: "pending" | "repaid" | "overdue";
  repaidAt?: string;
}

export interface Loan {
  id: string;
  vaultId: string;
  beneficiaryId: string;
  guarantorId: string;
  principalLocal: number;
  principalUsd: number;
  localCurrency: string;
  ltvRatio: number;            // e.g. 1.50 (150%) or 1.10 (110%)
  collateralLockedUsd: number;    // collateral locked at origination (principalUsd * ltvRatio)
  collateralReleasedUsd: number;  // cumulative collateral released back to the guarantor
  collateralForfeitedUsd: number; // cumulative collateral forfeited to settlement on default
  installmentCount: number;
  installmentIntervalDays: number;
  schedule: InstallmentScheduleItem[];
  status: LoanStatus;
  graceExpiresAt?: string;
  purpose?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepaymentAttestation {
  id: string;
  loanId: string;
  installmentNumber: number;
  amountLocal: number;
  amountUsd: number;
  attestedBy: string;
  partnerSignature: string;
  attestedAt: string;
  createdAt: string;
}

export type AuditEventType =
  | "AUTH"
  | "GUARANTOR"
  | "VAULT"
  | "BENEFICIARY"
  | "LOAN"
  | "REPAYMENT"
  | "REMITTANCE"
  | "REPUTATION"
  | "SYSTEM";

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  action: string;
  actor?: string;
  entityType?: string;
  entityId?: string;
  details: Record<string, any> | string;
  createdAt: string;
}

// ─── DTOs & Request Inputs ───────────────────────────────────────────

export interface RegisterGuarantorDTO {
  walletAddress: string;
  displayName?: string;
}

export interface DepositVaultDTO {
  amountUsd: number;
  txHash?: string;
}

export interface WithdrawVaultDTO {
  amountUsd: number;
  destinationAddress: string;
}

export interface RegisterBeneficiaryDTO {
  phoneNumber: string;
  localKycRef: string;
}

export interface IngestRemittanceDTO {
  guarantorId: string;
  beneficiaryId: string;
  amountUsd: number;
  localAmount: number;
  localCurrency: string;
  source: RemittanceSource;
  sentAt: string;
}

export interface OriginateLoanDTO {
  beneficiaryId: string;
  principalLocal: number;
  localCurrency: string;
  installmentCount: number;
  installmentIntervalDays?: number;
  purpose?: string;
}

export interface SubmitAttestationDTO {
  loanId: string;
  installmentNumber: number;
  amountLocal: number;
  amountUsd: number;
  attestedBy: string;
  partnerSignature: string;
  attestedAt: string;
}

// ─── Off-Ramp Adapter Types (§6) ────────────────────────────────────

export interface DisbursementRequest {
  loan_id: string;
  beneficiary_phone: string;
  beneficiary_kyc_ref: string;
  amount_local: number;
  local_currency: string;
  idempotency_key: string;
}

export interface DisbursementResult {
  success: boolean;
  partner_reference: string;
  disbursed_at: string;
  failure_reason?: string;
}

export interface OffRampRemittanceRecord {
  amount_usd: number;
  local_amount: number;
  local_currency: string;
  sent_at: string;
}

export interface OffRampAttestation {
  loan_id: string;
  installment_number: number;
  amount_local: number;
  amount_usd: number;
  beneficiary_phone: string;
  attested_at: string;
  partner_signature: string;
}

// ─── Auth Types ─────────────────────────────────────────────────────

export interface AuthChallenge {
  walletAddress: string;
  /** The exact message the wallet must sign. */
  challenge: string;
  expiresAt: string;
}

/** A signed-in wallet. Stored under a hash of its token, never the token itself. */
export interface Session {
  walletAddress: string;
  expiresAt: string;
}

// ─── Contract Gateway Types (§10) ───────────────────────────────────

export interface ContractCallResult {
  success: boolean;
  /** Stellar transaction hash, or a simulated reference under the mock gateway. */
  txHash: string;
  /** Soroban contract the call was routed to. */
  contract: "GuarantorVault" | "LoanLedger" | "LiquidationEngine";
  /** Contract function invoked. */
  method: string;
  ledgerAt: string;
  failureReason?: string;
}

export interface CollateralPosition {
  vaultId: string;
  collateralBalance: number;
  lockedAmount: number;
  availableAmount: number;
  /** Locked amount attributed to each loan the vault backs. */
  perLoanLocked: Record<string, number>;
}
