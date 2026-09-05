import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { loans } from "../stores";
import * as loanService from "../services/loan.service";

export const loanRouter = Router();

/**
 * POST /loans — Originate a loan.
 */
loanRouter.post("/", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { beneficiaryId, principalLocal, localCurrency, installmentCount, installmentIntervalDays, purpose } = req.body;

  if (!beneficiaryId || !principalLocal || !localCurrency || !installmentCount) {
    return res.status(400).json({
      error: "Missing required fields: beneficiaryId, principalLocal, localCurrency, installmentCount",
    });
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

    return res.status(201).json({
      message: "Loan originated successfully",
      loan,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /loans — List loans for the authenticated guarantor.
 */
loanRouter.get("/", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { status } = req.query;
  let myLoans = Array.from(loans.values()).filter(
    (l) => l.guarantorId === guarantorId,
  );

  if (status) {
    myLoans = myLoans.filter((l) => l.status === status);
  }

  return res.json({ total: myLoans.length, loans: myLoans });
});

/**
 * GET /loans/:id — Loan details with repayment status.
 */
loanRouter.get("/:id", walletAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const loan = loans.get(id);

  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    // Not distinguished from "not found": telling a caller that a loan
    // exists but belongs to someone else leaks that it exists at all.
    return res.status(404).json({ error: "Loan not found" });
  }

  const repaidCount = loan.schedule.filter((s) => s.status === "repaid").length;
  const totalRepaidUsd = loan.schedule
    .filter((s) => s.status === "repaid")
    .reduce((sum, s) => sum + s.amountUsd, 0);

  return res.json({
    ...loan,
    repaymentProgress: {
      installmentsRepaid: repaidCount,
      installmentsTotal: loan.installmentCount,
      totalRepaidUsd,
      percentComplete: Math.round((repaidCount / loan.installmentCount) * 100),
    },
  });
});

/**
 * GET /loans/:id/schedule — Full installment schedule with payment status.
 */
loanRouter.get("/:id/schedule", walletAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const loan = loans.get(id);

  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    return res.status(404).json({ error: "Loan not found" });
  }

  return res.json({
    loanId: loan.id,
    localCurrency: loan.localCurrency,
    schedule: loan.schedule,
  });
});
