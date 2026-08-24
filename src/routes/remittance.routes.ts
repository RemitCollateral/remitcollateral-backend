import { Router, Request, Response } from "express";
import { walletAuth, partnerAuth } from "../middleware/auth.middleware";
import { RemittanceRecord } from "../types";
import {
  remittanceRecords,
  beneficiaries,
  walletToGuarantor,
  guarantors,
  generateId,
} from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { refreshReputationScore } from "../services/reputation.service";

export const remittanceRouter = Router();

/**
 * POST /remittances — Record a remittance (self-declared or partner-reported).
 */
remittanceRouter.post("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { beneficiaryId, amountUsd, localAmount, localCurrency, source, sentAt } = req.body;

  if (!beneficiaryId || !amountUsd || !localAmount || !localCurrency || !source || !sentAt) {
    return res.status(400).json({
      error: "Missing required fields: beneficiaryId, amountUsd, localAmount, localCurrency, source, sentAt",
    });
  }

  if (source !== "partner_reported" && source !== "self_declared") {
    return res.status(400).json({
      error: "source must be 'partner_reported' or 'self_declared'",
    });
  }

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

  return res.status(201).json({
    message: "Remittance recorded successfully",
    remittance: record,
  });
});

/**
 * GET /remittances — List remittances for the authenticated guarantor.
 */
remittanceRouter.get("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { beneficiaryId } = req.query;
  let records = remittanceRecords.filter((r) => r.guarantorId === guarantorId);

  if (beneficiaryId) {
    records = records.filter((r) => r.beneficiaryId === beneficiaryId);
  }

  records.sort(
    (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
  );

  return res.json({ total: records.length, remittances: records });
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

  for (const r of records) {
    if (!r.guarantorId || !r.beneficiaryId || !r.amountUsd || !r.localAmount || !r.localCurrency || !r.sentAt) {
      results.errors.push(`Skipped record: missing fields`);
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

  // Refresh reputation for all affected beneficiaries
  for (const bId of beneficiariesToRefresh) {
    try {
      refreshReputationScore(bId);
    } catch (_) {
      // beneficiary may not exist yet
    }
  }

  logAuditEvent({
    eventType: "REMITTANCE",
    action: "BATCH_INGESTED",
    details: { imported: results.imported, errors: results.errors.length },
  });

  return res.json({
    message: `Imported ${results.imported} remittance records`,
    ...results,
  });
});
