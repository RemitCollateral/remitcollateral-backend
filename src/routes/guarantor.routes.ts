import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import { Guarantor } from "../types";
import {
  guarantors,
  walletToGuarantor,
  loans,
  generateId,
} from "../stores";
import { logAuditEvent } from "../services/audit.service";
import * as vaultService from "../services/vault.service";

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

  const guarantor: Guarantor = {
    id: generateId(),
    walletAddress,
    displayName,
    createdAt: new Date().toISOString(),
  };

  guarantors.set(guarantor.id, guarantor);
  walletToGuarantor.set(walletAddress, guarantor.id);

  // Auto-create vault
  vaultService.getOrCreateVault(guarantor.id);

  logAuditEvent({
    eventType: "GUARANTOR",
    action: "GUARANTOR_REGISTERED",
    actor: walletAddress,
    entityType: "guarantor",
    entityId: guarantor.id,
    details: { displayName },
  });

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
 * GET /guarantors/me/dashboard — Full dashboard data.
 */
guarantorRouter.get("/me/dashboard", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const guarantor = guarantors.get(guarantorId);
  const balance = vaultService.getBalance(guarantorId);

  // Get all loans for this guarantor
  const myLoans = Array.from(loans.values())
    .filter((l) => l.guarantorId === guarantorId)
    .map((loan) => {
      const nextInstallment = loan.schedule.find((s) => s.status === "pending");
      const overdueCount = loan.schedule.filter((s) => s.status === "overdue").length;

      return {
        id: loan.id,
        beneficiaryId: loan.beneficiaryId,
        principalLocal: loan.principalLocal,
        localCurrency: loan.localCurrency,
        status: loan.status,
        ltvRatio: loan.ltvRatio,
        installmentsTotal: loan.installmentCount,
        installmentsRepaid: loan.schedule.filter((s) => s.status === "repaid").length,
        installmentsOverdue: overdueCount,
        nextInstallment: nextInstallment
          ? { amount: nextInstallment.amountLocal, dueAt: nextInstallment.dueAt }
          : null,
        riskLevel: overdueCount > 0 ? "high" : loan.status === "grace" ? "medium" : "low",
        createdAt: loan.createdAt,
      };
    });

  return res.json({
    guarantor,
    vault: balance,
    loans: myLoans,
    summary: {
      totalLoans: myLoans.length,
      activeLoans: myLoans.filter((l) => l.status === "active" || l.status === "grace").length,
      repaidLoans: myLoans.filter((l) => l.status === "repaid").length,
      defaultedLoans: myLoans.filter((l) => l.status === "defaulted").length,
    },
  });
});
