import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import * as vaultService from "../services/vault.service";

export const vaultRouter = Router();

/**
 * POST /vaults/deposit — Record a USDC deposit into the guarantor's vault.
 */
vaultRouter.post("/deposit", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { amountUsd, txHash } = req.body;

  if (!amountUsd || typeof amountUsd !== "number" || amountUsd <= 0) {
    return res.status(400).json({ error: "Invalid amountUsd. Must be a positive number." });
  }

  try {
    const vault = await vaultService.deposit(guarantorId, amountUsd, txHash);
    return res.json({
      message: `${amountUsd} USDC deposited successfully`,
      vault: {
        total: vault.collateralBalance,
        locked: vault.lockedAmount,
        available: vault.collateralBalance - vault.lockedAmount,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /vaults/withdraw — Withdraw unlocked collateral.
 */
vaultRouter.post("/withdraw", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const { amountUsd, destinationAddress } = req.body;

  if (!amountUsd || typeof amountUsd !== "number" || amountUsd <= 0) {
    return res.status(400).json({ error: "Invalid amountUsd. Must be a positive number." });
  }

  if (!destinationAddress) {
    return res.status(400).json({ error: "Missing destinationAddress" });
  }

  try {
    const vault = await vaultService.withdraw(guarantorId, amountUsd, destinationAddress);
    return res.json({
      message: `${amountUsd} USDC withdrawn to ${destinationAddress}`,
      vault: {
        total: vault.collateralBalance,
        locked: vault.lockedAmount,
        available: vault.collateralBalance - vault.lockedAmount,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /vaults/me — Vault balance breakdown.
 */
vaultRouter.get("/me", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const balance = vaultService.getBalance(guarantorId);
  return res.json(balance);
});
