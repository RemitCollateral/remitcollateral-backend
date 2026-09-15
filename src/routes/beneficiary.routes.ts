import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { Beneficiary } from "../types";
import { beneficiaries, generateId } from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { getReputationBreakdown } from "../services/reputation.service";
import { seedRemittanceHistory } from "../services/remittance.service";
import { serializeBeneficiary, serializeReputation } from "../api/serializers";

export const beneficiaryRouter = Router();

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * POST /beneficiaries — Register a beneficiary.
 *   { phone_number, local_kyc_ref, local_currency, display_name? }
 */
beneficiaryRouter.post("/", walletAuth, async (req: Request, res: Response) => {
  const walletAddress = (req as any).walletAddress as string;
  const phoneNumber = text(req.body?.phone_number);
  const localKycRef = text(req.body?.local_kyc_ref);
  const localCurrency = text(req.body?.local_currency).toUpperCase();
  const displayName = text(req.body?.display_name) || undefined;

  if (!phoneNumber || !localKycRef) {
    return res.status(400).json({
      error:
        "phone_number and local_kyc_ref are required. The KYC reference comes from your off-ramp partner.",
    });
  }
  if (!/^[A-Z]{3}$/.test(localCurrency)) {
    return res.status(400).json({ error: "local_currency must be an ISO 4217 code, e.g. NGN" });
  }

  // The existing record is not returned: it may belong to another guarantor,
  // and echoing it would disclose their beneficiary's details to anyone who
  // tries a phone number.
  const taken = Array.from(beneficiaries.values()).some((b) => b.phoneNumber === phoneNumber);
  if (taken) {
    return res.status(409).json({ error: "A beneficiary with this phone number already exists" });
  }

  const beneficiary: Beneficiary = {
    id: generateId(),
    phoneNumber,
    localKycRef,
    reputationScore: 0,
    displayName,
    localCurrency,
    createdAt: new Date().toISOString(),
  };
  beneficiaries.set(beneficiary.id, beneficiary);

  logAuditEvent({
    eventType: "BENEFICIARY",
    action: "BENEFICIARY_REGISTERED",
    actor: walletAddress,
    entityType: "beneficiary",
    entityId: beneficiary.id,
    details: { phoneNumber },
  });

  // §8.2 — pull whatever history the partner already holds for this pair, so
  // the beneficiary starts with the cold-start signal rather than at zero.
  const guarantorId = (req as any).guarantorId as string | undefined;
  if (guarantorId) {
    await seedRemittanceHistory(guarantorId, walletAddress, beneficiary.id, beneficiary.phoneNumber);
  }

  return res.status(201).json(serializeBeneficiary(beneficiaries.get(beneficiary.id)!));
});

/**
 * GET /beneficiaries/:id — A beneficiary, with their reputation score.
 */
beneficiaryRouter.get("/:id", walletAuth, (req: Request, res: Response) => {
  const beneficiary = beneficiaries.get(req.params.id);
  if (!beneficiary) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }
  return res.json(serializeBeneficiary(beneficiary));
});

/**
 * GET /beneficiaries/:id/reputation — The breakdown behind the score.
 */
beneficiaryRouter.get("/:id/reputation", walletAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  if (!beneficiaries.has(id)) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }
  return res.json(serializeReputation(id, getReputationBreakdown(id)));
});
