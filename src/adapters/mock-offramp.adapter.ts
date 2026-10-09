import { OffRampAdapter } from "./offramp.interface";
import {
  DisbursementRequest,
  DisbursementResult,
  ExchangeRate,
  OffRampAttestation,
  OffRampRemittanceRecord,
} from "../types";
import { logger } from "../logging/logger";
import { config } from "../config";
import { verifyPartnerSignature } from "../chain/attestation";

const log = logger.child({ component: "mock-offramp" });

/** Indicative rates, local units per 1 USD. The same figures the frontend's mock uses. */
export const INDICATIVE_RATES: Record<string, number> = {
  NGN: 1580,
  GHS: 15.4,
  XOF: 608,
  KES: 129,
  USD: 1,
};

/**
 * Mock Off-Ramp Adapter (§6.2)
 *
 * For development and testing. Simulates partner behavior:
 * - disburse() always succeeds after 500ms delay
 * - verifyAttestation() checks the signature against the partner's registered
 *   Stellar key (PARTNER_STELLAR_ADDRESS). With no key configured it accepts any
 *   non-empty signature outside production and refuses everything in production
 * - getDisbursementStatus() returns success for known references
 * - fetchRemittanceHistory() returns configurable seed data
 * - getExchangeRate() quotes fixed indicative rates for the currencies above
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

    log.info(
      {
        amountLocal: request.amount_local,
        localCurrency: request.local_currency,
        beneficiaryPhone: request.beneficiary_phone,
        partnerReference: result.partner_reference,
      },
      "disbursed",
    );

    return result;
  }

  async verifyAttestation(attestation: OffRampAttestation): Promise<boolean> {
    const partnerAddress = config.chain.partnerAddress;
    let valid: boolean;

    if (partnerAddress) {
      // The signature must be the registered partner's, over exactly these figures.
      valid = verifyPartnerSignature(partnerAddress, attestation);
    } else if (process.env.NODE_ENV === "production") {
      // No key to check against: refuse, rather than let a missing setting turn
      // the check into a rubber stamp.
      log.error("PARTNER_STELLAR_ADDRESS is not set, so no attestation can be verified");
      valid = false;
    } else {
      // Local development with no partner key configured.
      valid = !!attestation.partner_signature && attestation.partner_signature.length > 0;
    }

    log.info(
      { loanId: attestation.loan_id, installmentNumber: attestation.installment_number, valid },
      "attestation verification",
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

  async getExchangeRate(localCurrency: string): Promise<ExchangeRate> {
    const rate = INDICATIVE_RATES[localCurrency];
    if (!rate) {
      throw new Error(`The off-ramp partner does not pay out in ${localCurrency}`);
    }
    return { local_currency: localCurrency, local_per_usd: rate, quoted_at: new Date().toISOString() };
  }

  async fetchRemittanceHistory(
    _guarantorWallet: string,
    _beneficiaryPhone: string,
    _since: string,
  ): Promise<OffRampRemittanceRecord[]> {
    // Off unless explicitly asked for. These records are stored as
    // partner_reported and carry full scoring weight, so inventing them
    // means quoting a real guarantor less collateral than the protocol
    // should require, on the strength of transfers that never happened.
    // A beneficiary with no history scores zero and posts the full base
    // LTV, which is the correct answer for someone with no history.
    if (!config.mockPartnerSeedHistory) return [];

    // Seed data for local demos and reputation-scoring experiments only.
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
