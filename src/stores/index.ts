import crypto from "crypto";
import {
  Guarantor,
  Vault,
  Beneficiary,
  BeneficiaryLink,
  Loan,
  RemittanceRecord,
  RepaymentAttestation,
  AuditEvent,
  AuthChallenge,
  Session,
} from "../types";

// ─── In-Memory Stores ────────────────────────────────────────────────

export const guarantors: Map<string, Guarantor> = new Map();
export const vaults: Map<string, Vault> = new Map();
export const beneficiaries: Map<string, Beneficiary> = new Map();
/** Guarantor ID → beneficiary ID → the guarantor's link to that beneficiary. */
export const beneficiaryLinks: Map<string, Map<string, BeneficiaryLink>> = new Map();
export const loans: Map<string, Loan> = new Map();
export const remittanceRecords: RemittanceRecord[] = [];
export const repaymentAttestations: RepaymentAttestation[] = [];
export const auditEvents: AuditEvent[] = [];
/** Outstanding sign-in challenges, per wallet address. */
export const authChallenges: Map<string, AuthChallenge[]> = new Map();
/** Live sessions, keyed by the SHA-256 hash of their token. */
export const sessions: Map<string, Session> = new Map();

// ─── Lookup Indexes ──────────────────────────────────────────────────

/** Map from wallet address → guarantor ID for quick lookups */
export const walletToGuarantor: Map<string, string> = new Map();

/** Map from guarantor ID → vault ID */
export const guarantorToVault: Map<string, string> = new Map();

// ─── UUID Helper ─────────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID();
}
