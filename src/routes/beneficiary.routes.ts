import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { Beneficiary } from "../types";
import { beneficiaries, generateId } from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { getReputationBreakdown } from "../services/reputation.service";

export const beneficiaryRouter = Router();

/**
 * POST /beneficiaries — Register a beneficiary (phone + KYC ref).
 */
beneficiaryRouter.post("/", walletAuth, (req: Request, res: Response) => {
  const walletAddress = (req as any).walletAddress as string;
  const { phoneNumber, localKycRef } = req.body;

  if (!phoneNumber || !localKycRef) {
    return res.status(400).json({
      error: "Missing required fields: phoneNumber, localKycRef",
    });
  }

  // Check for duplicate phone number
  const existing = Array.from(beneficiaries.values()).find(
    (b) => b.phoneNumber === phoneNumber,
  );
  if (existing) {
    return res.status(409).json({
      error: "A beneficiary with this phone number already exists",
      beneficiary: existing,
    });
  }

  const beneficiary: Beneficiary = {
    id: generateId(),
    phoneNumber,
    localKycRef,
    reputationScore: 0,
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

  return res.status(201).json({
    message: "Beneficiary registered successfully",
    beneficiary,
  });
});

/**
 * GET /beneficiaries/:id — Get beneficiary details and reputation score.
 */
beneficiaryRouter.get("/:id", walletAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const beneficiary = beneficiaries.get(id);

  if (!beneficiary) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }

  return res.json(beneficiary);
});

/**
 * GET /beneficiaries/:id/reputation — Detailed reputation breakdown.
 */
beneficiaryRouter.get("/:id/reputation", walletAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const beneficiary = beneficiaries.get(id);

  if (!beneficiary) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }

  const breakdown = getReputationBreakdown(id);

  return res.json({
    beneficiaryId: id,
    ...breakdown,
  });
});
