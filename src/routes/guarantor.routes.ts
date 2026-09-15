import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { Guarantor } from "../types";
import {
  guarantors,
  walletToGuarantor,
  loans,
  beneficiaries,
} from "../stores";
import { createGuarantor } from "../services/guarantor.service";
import * as vaultService from "../services/vault.service";
import { outstandingCollateral } from "../services/loan.service";

export const guarantorRouter = Router();

/**
 * POST /guarantors — Register as a guarantor.
 */
guarantorRouter.post("/", walletAuth, (req: Request, res: Response) => {
  const walletAddress = (req as any).walletAddress as string;
  const { displayName } = req.body;

  // Check if already registered
  if (walletToGuarantor.has(walletAddress)) {
    const existingId = walletToGuarantor.get(walletAddress)!;
    return res.status(409).json({
      error: "Guarantor already registered",
      guarantor: guarantors.get(existingId),
    });
  }

  const guarantor = createGuarantor(walletAddress, displayName);

  return res.status(201).json({
    message: "Guarantor registered successfully",
    guarantor,
  });
});

/**
 * GET /guarantors/me — Get own profile and vault summary.
 */
guarantorRouter.get("/me", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const guarantor = guarantors.get(guarantorId);
  const balance = vaultService.getBalance(guarantorId);

  return res.json({ guarantor, vault: balance });
});

/**
 * GET /guarantors/me/dashboard — Full dashboard data (§3.6).
 *
 * Serves the five things §3.6 requires: active loans with per-beneficiary
 * repayment status, collateral locked vs. available vs. released, the
 * upcoming installment schedule with a countdown, default risk indicators,
 * and each linked beneficiary's reputation score.
 *
 * Overdue counts are derived from the due dates on read rather than from the
 * stored installment status. The lifecycle sweep is what writes that status
 * and it runs on an interval, so between ticks a loan can be past due while
 * still stored as pending — and §3.5 makes the point that the guarantor sees
 * default risk explicitly before originating a loan, which a figure that
 * lags the clock by up to an hour would not deliver. This handler only reads;
 * advancing loan status stays with the sweep.
 */
guarantorRouter.get("/me/dashboard", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const guarantor = guarantors.get(guarantorId);
  const balance = vaultService.getBalance(guarantorId);
  const now = Date.now();

  const myLoans = Array.from(loans.values()).filter(
    (l) => l.guarantorId === guarantorId,
  );

  const loanViews = myLoans.map((loan) => {
    const isOpen = loan.status === "active" || loan.status === "grace";

    const overdue = loan.schedule.filter(
      (item) =>
        item.status === "overdue" ||
        (item.status === "pending" && isOpen && new Date(item.dueAt).getTime() < now),
    );

    const nextDue = loan.schedule
      .filter((item) => item.status === "pending" && new Date(item.dueAt).getTime() >= now)
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];

    const repaid = loan.schedule.filter((item) => item.status === "repaid");
    const repaidUsd = repaid.reduce((sum, item) => sum + item.amountUsd, 0);

    const beneficiary = beneficiaries.get(loan.beneficiaryId);

    return {
      id: loan.id,
      status: loan.status,
      ltvRatio: loan.ltvRatio,
      principalLocal: loan.principalLocal,
      principalUsd: loan.principalUsd,
      localCurrency: loan.localCurrency,
      purpose: loan.purpose,
      createdAt: loan.createdAt,

      // Per-beneficiary repayment status, with the reputation score that
      // determined the LTV this loan was written at.
      beneficiary: beneficiary
        ? {
            id: beneficiary.id,
            phoneNumber: beneficiary.phoneNumber,
            reputationScore: beneficiary.reputationScore,
          }
        : null,

      repayment: {
        installmentsTotal: loan.installmentCount,
        installmentsRepaid: repaid.length,
        installmentsOverdue: overdue.length,
        repaidUsd: Math.round(repaidUsd * 100) / 100,
        outstandingUsd: Math.round((loan.principalUsd - repaidUsd) * 100) / 100,
        percentComplete: Math.round((repaid.length / loan.installmentCount) * 100),
      },

      collateral: {
        lockedAtOrigination: loan.collateralLockedUsd,
        released: loan.collateralReleasedUsd,
        forfeited: loan.collateralForfeitedUsd,
        stillLocked: outstandingCollateral(loan),
      },

      // Upcoming installment with a countdown, so the frontend does not have
      // to agree with the backend about what "now" is.
      nextInstallment: nextDue
        ? {
            installmentNumber: nextDue.installmentNumber,
            amountLocal: nextDue.amountLocal,
            amountUsd: nextDue.amountUsd,
            dueAt: nextDue.dueAt,
            daysUntilDue: Math.ceil(
              (new Date(nextDue.dueAt).getTime() - now) / (24 * 60 * 60 * 1000),
            ),
          }
        : null,

      // Default risk, stated explicitly (§3.5).
      risk: {
        level:
          loan.status === "defaulted"
            ? "defaulted"
            : overdue.length > 0 || loan.status === "grace"
              ? "high"
              : nextDue &&
                  new Date(nextDue.dueAt).getTime() - now < 7 * 24 * 60 * 60 * 1000
                ? "medium"
                : "low",
        missedPayments: overdue.length,
        inGracePeriod: loan.status === "grace",
        graceExpiresAt: loan.graceExpiresAt || null,
        daysUntilDefault:
          loan.status === "grace" && loan.graceExpiresAt
            ? Math.max(
                0,
                Math.ceil(
                  (new Date(loan.graceExpiresAt).getTime() - now) / (24 * 60 * 60 * 1000),
                ),
              )
            : null,
        collateralAtRisk:
          loan.status === "active" || loan.status === "grace"
            ? Math.min(
                outstandingCollateral(loan),
                Math.round((loan.principalUsd - repaidUsd) * 100) / 100,
              )
            : 0,
      },
    };
  });

  const openLoans = loanViews.filter(
    (l) => l.status === "active" || l.status === "grace",
  );

  const totalReleased = myLoans.reduce((sum, l) => sum + l.collateralReleasedUsd, 0);
  const totalForfeited = myLoans.reduce((sum, l) => sum + l.collateralForfeitedUsd, 0);

  return res.json({
    guarantor,

    // Collateral locked vs. available vs. released (§3.6).
    collateral: {
      total: balance.total,
      locked: balance.locked,
      available: balance.available,
      released: Math.round(totalReleased * 100) / 100,
      forfeited: Math.round(totalForfeited * 100) / 100,
    },

    loans: loanViews,

    // The next few payments due across every open loan, nearest first.
    upcomingInstallments: openLoans
      .filter((l) => l.nextInstallment)
      .map((l) => ({
        loanId: l.id,
        beneficiaryId: l.beneficiary?.id || null,
        localCurrency: l.localCurrency,
        ...l.nextInstallment!,
      }))
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),

    summary: {
      totalLoans: loanViews.length,
      activeLoans: openLoans.length,
      repaidLoans: loanViews.filter((l) => l.status === "repaid").length,
      defaultedLoans: loanViews.filter((l) => l.status === "defaulted").length,
      loansAtRisk: openLoans.filter((l) => l.risk.level === "high").length,
      totalMissedPayments: openLoans.reduce((sum, l) => sum + l.risk.missedPayments, 0),
      collateralAtRisk:
        Math.round(openLoans.reduce((sum, l) => sum + l.risk.collateralAtRisk, 0) * 100) /
        100,
    },
  });
});
