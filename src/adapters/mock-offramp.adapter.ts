import { OffRampAdapter } from "./offramp.interface";
import {
  DisbursementRequest,
  DisbursementResult,
  OffRampAttestation,
  OffRampRemittanceRecord,
} from "../types";

/**
 * Mock Off-Ramp Adapter (§6.2)
 *
 * For development and testing. Simulates partner behavior:
 * - disburse() always succeeds after 500ms delay
 * - verifyAttestation() accepts any non-empty signature
 * - getDisbursementStatus() returns success for known references
 * - fetchRemittanceHistory() returns configurable seed data
 */
export class MockOffRampAdapter implements OffRampAdapter {
  private knownReferences: Map<string, DisbursementResult> = new Map();

  async disburse(request: DisbursementRequest): Promise<DisbursementResult> {
    // Simulate processing delay
    await this.delay(500);

    const result: DisbursementResult = {
      success: true,
      partner_reference: `MOCK-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      disbursed_at: new Date().toISOString(),
    };

    this.knownReferences.set(result.partner_reference, result);

    console.log(
      `[MockOffRamp]: Disbursed ${request.amount_local} ${request.local_currency} ` +
      `to ${request.beneficiary_phone} (ref: ${result.partner_reference})`,
    );

    return result;
  }

  async verifyAttestation(attestation: OffRampAttestation): Promise<boolean> {
    // Accept any attestation where partner_signature is non-empty
    const valid = !!attestation.partner_signature && attestation.partner_signature.length > 0;

    console.log(
      `[MockOffRamp]: Attestation verification for loan ${attestation.loan_id}, ` +
      `installment ${attestation.installment_number}: ${valid ? "VALID" : "INVALID"}`,
    );

    return valid;
  }

  async getDisbursementStatus(partnerReference: string): Promise<DisbursementResult> {
    const known = this.knownReferences.get(partnerReference);
    if (known) {
      return known;
    }

    // Return success for any reference (mock behavior)
    return {
      success: true,
      partner_reference: partnerReference,
      disbursed_at: new Date().toISOString(),
    };
  }

  async fetchRemittanceHistory(
    _guarantorWallet: string,
    _beneficiaryPhone: string,
    _since: string,
  ): Promise<OffRampRemittanceRecord[]> {
    // Return configurable seed data for testing reputation scoring
    return [
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(11),
      },
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(10),
      },
      {
        amount_usd: 250,
        local_amount: 200000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(9),
      },
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(8),
      },
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(7),
      },
      {
        amount_usd: 300,
        local_amount: 240000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(6),
      },
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(5),
      },
      {
        amount_usd: 200,
        local_amount: 160000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(3),
      },
      {
        amount_usd: 250,
        local_amount: 200000,
        local_currency: "NGN",
        sent_at: this.monthsAgo(1),
      },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private monthsAgo(months: number): string {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString();
  }
}
