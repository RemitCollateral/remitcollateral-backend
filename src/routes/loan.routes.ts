import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { loans } from "../stores";
import * as loanService from "../services/loan.service";
import { serializeLoan, serializeSchedule } from "../api/serializers";
import { loanView, loanViewsFor } from "../api/loan-views";
import { linkOf } from "../services/beneficiary.service";

export const loanRouter = Router();

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * POST /loans — Originate a loan.
 *   { beneficiary_id, principal_local, local_currency, installment_count,
 *     installment_interval_days, purpose? }
 */
loanRouter.post("/", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const body = req.body ?? {};
  const beneficiaryId = typeof body.beneficiary_id === "string" ? body.beneficiary_id : "";
  const localCurrency = typeof body.local_currency === "string" ? body.local_currency.toUpperCase() : "";
  const { principal_local: principalLocal, installment_count: installmentCount } = body;
  const installmentIntervalDays = positive(body.installment_interval_days)
    ? body.installment_interval_days
    : undefined;
  const purpose = typeof body.purpose === "string" && body.purpose.trim() ? body.purpose.trim() : undefined;

  if (!beneficiaryId || !localCurrency || !positive(principalLocal) || !Number.isInteger(installmentCount) || installmentCount < 1) {
    return res.status(400).json({
      error:
        "beneficiary_id, local_currency, a positive principal_local and a whole installment_count of at least 1 are required",
    });
  }

  // Only for a beneficiary on the guarantor's own list.
  if (!linkOf(guarantorId, beneficiaryId)) {
    return res.status(404).json({ error: "Beneficiary not found" });
  }

  try {
    const loan = await loanService.originateLoan(guarantorId, {
      beneficiaryId,
      principalLocal,
      localCurrency,
      installmentCount,
      installmentIntervalDays,
      purpose,
    });
    return res.status(201).json(serializeLoan(loan));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /loans — Every loan the guarantor's collateral backs, most urgent first.
 */
loanRouter.get("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { status } = req.query;
  const views = loanViewsFor(guarantorId);
  return res.json(status ? views.filter((view) => view.status === status) : views);
});

/**
 * GET /loans/:id — A loan with its beneficiary and repayment figures.
 */
loanRouter.get("/:id", walletAuth, (req: Request, res: Response) => {
  const loan = loans.get(req.params.id);
  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    // Not distinguished from "not found": telling a caller that a loan
    // exists but belongs to someone else leaks that it exists at all.
    return res.status(404).json({ error: "Loan not found" });
  }
  return res.json(loanView(loan));
});

/**
 * GET /loans/:id/schedule — The installment schedule with payment status.
 */
loanRouter.get("/:id/schedule", walletAuth, (req: Request, res: Response) => {
  const loan = loans.get(req.params.id);
  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    return res.status(404).json({ error: "Loan not found" });
  }
  return res.json(serializeSchedule(loan.schedule));
});
