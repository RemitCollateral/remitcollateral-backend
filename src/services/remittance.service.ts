import { RemittanceRecord } from "../types";
import { remittanceRecords, generateId } from "../stores";
import { OffRampAdapter } from "../adapters/offramp.interface";
import { logAuditEvent } from "./audit.service";
import { refreshReputationScore } from "./reputation.service";

// ─── Module-level adapter reference ──────────────────────────────────

let offRampAdapter: OffRampAdapter | undefined;

export function setOffRampAdapter(adapter: OffRampAdapter): void {
  offRampAdapter = adapter;
}

/** How far back to ask the partner for history when seeding a beneficiary. */
const SEED_LOOKBACK_MONTHS = 24;

/**
 * Pull the guarantor's remittance history to this beneficiary from the
 * off-ramp partner and record it (§6.1 `fetchRemittanceHistory`).
 *
 * §8.2 calls remittance history the key cold-start signal: it is the only
 * evidence available before a beneficiary has ever repaid anything, and
 * §8.1 weights it at 40%. Waiting for the partner to push a batch through
 * /remittances/ingest leaves a newly registered beneficiary scoring zero and
 * their guarantor posting the full 150% LTV, even when the partner already
 * holds a year of consistent transfers between exactly these two parties.
 *
 * Records arrive already attributed to the partner, so they are stored as
 * partner_reported and carry full weight — unlike anything the guarantor
 * declares themselves (§9.2).
 *
 * A partner that cannot serve history is not an error: the adapter method is
 * documented as optional ("if supported"), and registration must succeed
 * regardless. Failures are logged and the beneficiary simply starts at zero.
 */
export async function seedRemittanceHistory(
  guarantorId: string,
  guarantorWallet: string,
  beneficiaryId: string,
  beneficiaryPhone: string,
): Promise<number> {
  if (!offRampAdapter) return 0;

  const since = new Date();
  since.setMonth(since.getMonth() - SEED_LOOKBACK_MONTHS);

  let history;
  try {
    history = await offRampAdapter.fetchRemittanceHistory(
      guarantorWallet,
      beneficiaryPhone,
      since.toISOString(),
    );
  } catch (err) {
    logAuditEvent({
      eventType: "REMITTANCE",
      action: "HISTORY_FETCH_FAILED",
      actor: guarantorId,
      entityType: "beneficiary",
      entityId: beneficiaryId,
      details: { message: (err as Error).message },
    });
    return 0;
  }

  if (!Array.isArray(history) || history.length === 0) return 0;

  const now = Date.now();
  let imported = 0;

  for (const entry of history) {
    const sentAt = new Date(entry.sent_at);
    if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > now) continue;

    const record: RemittanceRecord = {
      id: generateId(),
      guarantorId,
      beneficiaryId,
      amountUsd: entry.amount_usd,
      localAmount: entry.local_amount,
      localCurrency: entry.local_currency,
      source: "partner_reported",
      sentAt: sentAt.toISOString(),
      createdAt: new Date().toISOString(),
    };

    remittanceRecords.push(record);
    imported++;
  }

  if (imported === 0) return 0;

  const score = refreshReputationScore(beneficiaryId);

  logAuditEvent({
    eventType: "REMITTANCE",
    action: "HISTORY_SEEDED",
    actor: guarantorId,
    entityType: "beneficiary",
    entityId: beneficiaryId,
    details: { imported, lookbackMonths: SEED_LOOKBACK_MONTHS, scoreAfter: score },
  });

  return imported;
}
