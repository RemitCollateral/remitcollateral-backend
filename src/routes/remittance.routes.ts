import { Router, Request, Response } from "express";
import { walletAuth, partnerAuth } from "../middleware/auth.middleware";
import { RemittanceRecord, RemittanceSource } from "../types";
import {
  remittanceRecords,
  beneficiaries,
  walletToGuarantor,
  guarantors,
  generateId,
} from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { refreshReputationScore } from "../services/reputation.service";
import { serializeRemittance } from "../api/serializers";

export const remittanceRouter = Router();

/**
 * POST /remittances — Record a remittance (self-declared or partner-reported).
 */
remittanceRouter.post("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const beneficiaryId = req.body?.beneficiary_id;
  const amountUsd = req.body?.amount_usd;
  const localAmount = req.body?.local_amount;
  const localCurrency = req.body?.local_currency;
  const sentAt = req.body?.sent_at;

  if (!beneficiaryId || !amountUsd || !localAmount || !localCurrency || !sentAt) {
    return res.status(400).json({
      error: "Missing required fields: beneficiary_id, amount_usd, local_amount, local_currency, sent_at",
    });
  }

  // §9.2 — the protocol does not trust guarantor claims. Anything recorded
  // on a wallet-authenticated request is self-declared by definition; only
  // POST /remittances/ingest, behind the partner API key, may write
  // partner_reported records. The source is therefore assigned here rather
  // than accepted from the body.
  const source: RemittanceSource = "self_declared";

  const beneficiary = beneficiaries.get(beneficiaryId);
  if (!beneficiary) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }

  const record: RemittanceRecord = {
    id: generateId(),
    guarantorId,
    beneficiaryId,
    amountUsd,
    localAmount,
    localCurrency,
    source,
    sentAt,
    createdAt: new Date().toISOString(),
  };

  remittanceRecords.push(record);

  // Refresh reputation score on ingestion (§8.4)
  refreshReputationScore(beneficiaryId);

  logAuditEvent({
    eventType: "REMITTANCE",
    action: "REMITTANCE_RECORDED",
    actor: guarantorId,
    entityType: "beneficiary",
    entityId: beneficiaryId,
    details: { amountUsd, localAmount, localCurrency, source },
  });

  return res.status(201).json(serializeRemittance(record));
});

/**
 * GET /remittances — List remittances for the authenticated guarantor.
 */
remittanceRouter.get("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const beneficiaryId = req.query.beneficiary_id;
  let records = remittanceRecords.filter((r) => r.guarantorId === guarantorId);

  if (beneficiaryId) {
    records = records.filter((r) => r.beneficiaryId === beneficiaryId);
  }

  records.sort(
    (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
  );

  return res.json(records.map(serializeRemittance));
});

/**
 * POST /remittances/ingest — Batch-import remittance history from partner.
 */
remittanceRouter.post("/ingest", partnerAuth, (req: Request, res: Response) => {
  const { records } = req.body;

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: "Missing or empty records array" });
  }

  const results: { imported: number; errors: string[] } = {
    imported: 0,
    errors: [],
  };

  const beneficiariesToRefresh = new Set<string>();

  for (const [index, r] of records.entries()) {
    if (!r.guarantorId || !r.beneficiaryId || !r.amountUsd || !r.localAmount || !r.localCurrency || !r.sentAt) {
      results.errors.push(`Record ${index}: missing required fields`);
      continue;
    }

    // Both parties must exist. An imported record naming an unknown
    // beneficiary is silently unreachable — nothing ever reads it — while
    // one naming an unknown guarantor still counts toward that beneficiary's
    // remittance score under §8.2 at full partner weight, attributing a
    // history to a relationship the protocol has no record of.
    if (!guarantors.has(r.guarantorId)) {
      results.errors.push(`Record ${index}: unknown guarantor ${r.guarantorId}`);
      continue;
    }
    if (!beneficiaries.has(r.beneficiaryId)) {
      results.errors.push(`Record ${index}: unknown beneficiary ${r.beneficiaryId}`);
      continue;
    }

    const sentAt = new Date(r.sentAt);
    if (Number.isNaN(sentAt.getTime())) {
      results.errors.push(`Record ${index}: sentAt is not a valid date`);
      continue;
    }

    // §8.2 scores frequency, consistency and duration off these timestamps.
    // A future-dated record stretches the measured duration and skews the
    // gaps between records, so the score it produces is not one the history
    // actually supports.
    if (sentAt.getTime() > Date.now()) {
      results.errors.push(`Record ${index}: sentAt is in the future`);
      continue;
    }

    const record: RemittanceRecord = {
      id: generateId(),
      guarantorId: r.guarantorId,
      beneficiaryId: r.beneficiaryId,
      amountUsd: r.amountUsd,
      localAmount: r.localAmount,
      localCurrency: r.localCurrency,
      source: "partner_reported",
      sentAt: r.sentAt,
      createdAt: new Date().toISOString(),
    };

    remittanceRecords.push(record);
    results.imported++;
    beneficiariesToRefresh.add(r.beneficiaryId);
  }

  // Refresh reputation for all affected beneficiaries (§8.4)
  for (const bId of beneficiariesToRefresh) {
    refreshReputationScore(bId);
  }

  logAuditEvent({
    eventType: "REMITTANCE",
    action: "BATCH_INGESTED",
    details: { imported: results.imported, errors: results.errors.length },
  });

  return res.json({
    message:
      `Imported ${results.imported} of ${records.length} remittance records` +
      (results.errors.length > 0 ? `, ${results.errors.length} rejected` : ""),
    ...results,
  });
});
