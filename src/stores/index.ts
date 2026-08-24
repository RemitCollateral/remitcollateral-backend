import crypto from "crypto";
import {
  Guarantor,
  Vault,
  Beneficiary,
  Loan,
  RemittanceRecord,
  RepaymentAttestation,
  AuditEvent,
  AuthChallenge,
} from "../types";

// ─── In-Memory Stores ────────────────────────────────────────────────

export const guarantors: Map<string, Guarantor> = new Map();
export const vaults: Map<string, Vault> = new Map();
export const beneficiaries: Map<string, Beneficiary> = new Map();
export const loans: Map<string, Loan> = new Map();
export const remittanceRecords: RemittanceRecord[] = [];
export const repaymentAttestations: RepaymentAttestation[] = [];
export const auditEvents: AuditEvent[] = [];
export const authChallenges: Map<string, AuthChallenge> = new Map();

// ─── Lookup Indexes ──────────────────────────────────────────────────

/** Map from wallet address → guarantor ID for quick lookups */
export const walletToGuarantor: Map<string, string> = new Map();

/** Map from guarantor ID → vault ID */
export const guarantorToVault: Map<string, string> = new Map();

// ─── UUID Helper ─────────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID();
}
