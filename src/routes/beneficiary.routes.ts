import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { beneficiaries } from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { getReputationBreakdown } from "../services/reputation.service";
import { seedRemittanceHistory } from "../services/remittance.service";
import {
  BeneficiaryConflict,
  addBeneficiary,
  beneficiariesOf,
  linkOf,
} from "../services/beneficiary.service";
import { serializeBeneficiary, serializeReputation } from "../api/serializers";

export const beneficiaryRouter = Router();

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The beneficiary, only if the guarantor supports them. Otherwise not found. */
function ownBeneficiary(req: Request) {
  const guarantorId = (req as any).guarantorId as string | undefined;
  const link = guarantorId ? linkOf(guarantorId, req.params.id) : undefined;
  const beneficiary = link ? beneficiaries.get(link.beneficiaryId) : undefined;
  return beneficiary && link ? { beneficiary, link } : null;
}

/**
 * GET /beneficiaries — The beneficiaries the guarantor supports.
 */
beneficiaryRouter.get("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string | undefined;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }
  return res.json(
    beneficiariesOf(guarantorId).map(({ beneficiary, link }) => serializeBeneficiary(beneficiary, link)),
  );
});

/**
 * POST /beneficiaries — Add a beneficiary to the guarantor's list.
 *   { phone_number, local_kyc_ref, local_currency, display_name? }
 *
 * Someone another guarantor already supports is linked, not duplicated, when
 * the phone number and partner KYC reference both match.
 */
beneficiaryRouter.post("/", walletAuth, async (req: Request, res: Response) => {
  const walletAddress = (req as any).walletAddress as string;
  const guarantorId = (req as any).guarantorId as string | undefined;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

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

  let added;
  try {
    added = addBeneficiary(guarantorId, { phoneNumber, localKycRef, localCurrency, displayName });
  } catch (err) {
    // Nothing about an existing beneficiary is returned: they may be supported
    // by other guarantors, whose details are not this caller's to see.
    if (err instanceof BeneficiaryConflict) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }

  logAuditEvent({
    eventType: "BENEFICIARY",
    action: added.created ? "BENEFICIARY_REGISTERED" : "BENEFICIARY_LINKED",
    actor: walletAddress,
    entityType: "beneficiary",
    entityId: added.beneficiary.id,
    details: { guarantorId },
  });

  // §8.2 — pull whatever history the partner already holds for this pair, so
  // the relationship starts with the cold-start signal rather than at zero.
  await seedRemittanceHistory(guarantorId, walletAddress, added.beneficiary.id, phoneNumber);

  return res
    .status(201)
    .json(serializeBeneficiary(beneficiaries.get(added.beneficiary.id)!, added.link));
});

/**
 * GET /beneficiaries/:id — A beneficiary the guarantor supports.
 */
beneficiaryRouter.get("/:id", walletAuth, (req: Request, res: Response) => {
  const own = ownBeneficiary(req);
  if (!own) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }
  return res.json(serializeBeneficiary(own.beneficiary, own.link));
});

/**
 * GET /beneficiaries/:id/reputation — The breakdown behind their score.
 */
beneficiaryRouter.get("/:id/reputation", walletAuth, (req: Request, res: Response) => {
  const own = ownBeneficiary(req);
  if (!own) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }
  return res.json(serializeReputation(own.beneficiary.id, getReputationBreakdown(own.beneficiary.id)));
});
