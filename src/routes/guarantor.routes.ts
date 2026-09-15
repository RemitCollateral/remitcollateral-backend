import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { guarantors, walletToGuarantor } from "../stores";
import * as vaultService from "../services/vault.service";
import { createGuarantor } from "../services/guarantor.service";
import { serializeGuarantor, serializeVault } from "../api/serializers";
import { loanViewsFor } from "../api/loan-views";

export const guarantorRouter = Router();

/**
 * POST /guarantors — Register as a guarantor. Signing in registers a wallet
 * automatically; this endpoint remains for clients that register explicitly.
 */
guarantorRouter.post("/", walletAuth, (req: Request, res: Response) => {
  const walletAddress = (req as any).walletAddress as string;
  const displayName =
    typeof req.body?.display_name === "string" ? req.body.display_name.trim() || undefined : undefined;

  const existingId = walletToGuarantor.get(walletAddress);
  if (existingId) {
    return res.status(409).json({
      error: "Guarantor already registered",
      guarantor: serializeGuarantor(guarantors.get(existingId)!),
    });
  }

  return res.status(201).json(serializeGuarantor(createGuarantor(walletAddress, displayName)));
});

/**
 * GET /guarantors/me — The signed-in guarantor.
 */
guarantorRouter.get("/me", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  const guarantor = guarantorId ? guarantors.get(guarantorId) : undefined;
  if (!guarantor) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }
  return res.json(serializeGuarantor(guarantor));
});

/**
 * GET /guarantors/me/dashboard — Full dashboard data (§3.6).
 *
 * Every loan the guarantor's collateral backs, the vault's locked versus
 * available collateral, the next installments due across open loans, and the
 * loans at risk: those in grace or with a missed installment. Installment
 * status is derived from the due dates on read, so the risk shown never lags
 * the lifecycle sweep that advances loan status (§3.5).
 */
guarantorRouter.get("/me/dashboard", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  const guarantor = guarantorId ? guarantors.get(guarantorId) : undefined;
  if (!guarantor) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const loans = loanViewsFor(guarantorId);
  const open = loans.filter((loan) => loan.status === "active" || loan.status === "grace");

  const upcoming = open
    .flatMap((loan) =>
      loan.schedule
        .filter((entry) => entry.status !== "paid")
        .map((entry) => ({
          loan_id: loan.id,
          beneficiary_name: loan.beneficiary.display_name ?? loan.beneficiary.phone_number,
          local_currency: loan.local_currency,
          entry,
        })),
    )
    .sort((a, b) => a.entry.due_at.localeCompare(b.entry.due_at))
    .slice(0, 6);

  return res.json({
    guarantor: serializeGuarantor(guarantor),
    vault: serializeVault(vaultService.getOrCreateVault(guarantorId)),
    loans,
    upcoming_installments: upcoming,
    at_risk_loans: open.filter((loan) => loan.status === "grace" || loan.missed_installments > 0),
  });
});
