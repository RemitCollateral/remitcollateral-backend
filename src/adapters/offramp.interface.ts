import {
  DisbursementRequest,
  DisbursementResult,
  OffRampAttestation,
  OffRampRemittanceRecord,
} from "../types";

/**
 * Off-Ramp Adapter Interface (§6)
 *
 * Each off-ramp partner integration implements this interface.
 * The backend communicates with off-ramp partners exclusively through
 * this abstraction layer.
 */
export interface OffRampAdapter {
  /** Request disbursement of local currency to the beneficiary. */
  disburse(request: DisbursementRequest): Promise<DisbursementResult>;

  /** Verify the signature on a repayment attestation. */
  verifyAttestation(attestation: OffRampAttestation): Promise<boolean>;

  /** Check the status of a previously submitted disbursement. */
  getDisbursementStatus(partnerReference: string): Promise<DisbursementResult>;

  /** Fetch remittance history for a guarantor-beneficiary pair (if supported). */
  fetchRemittanceHistory(
    guarantorWallet: string,
    beneficiaryPhone: string,
    since: string,
  ): Promise<OffRampRemittanceRecord[]>;
}
