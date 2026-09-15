import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import * as vaultService from "../services/vault.service";
import { serializeVault } from "../api/serializers";

export const vaultRouter = Router();

const positiveAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * POST /vaults/deposit  { amount_usd, tx_hash? } — Record a USDC deposit.
 */
vaultRouter.post("/deposit", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const amountUsd = req.body?.amount_usd;
  const txHash = typeof req.body?.tx_hash === "string" ? req.body.tx_hash : undefined;
  if (!positiveAmount(amountUsd)) {
    return res.status(400).json({ error: "amount_usd must be a positive number" });
  }

  try {
    const vault = await vaultService.deposit(guarantorId, amountUsd, txHash);
    return res.json(serializeVault(vault));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /vaults/withdraw  { amount_usd } — Withdraw unlocked collateral.
 *
 * Always to the signed-in wallet. On-chain the vault can only pay the
 * guarantor's own account, and letting a request name another destination
 * would let a stolen session send collateral elsewhere.
 */
vaultRouter.post("/withdraw", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const amountUsd = req.body?.amount_usd;
  if (!positiveAmount(amountUsd)) {
    return res.status(400).json({ error: "amount_usd must be a positive number" });
  }

  try {
    const walletAddress = (req as any).walletAddress as string;
    const vault = await vaultService.withdraw(guarantorId, amountUsd, walletAddress);
    return res.json(serializeVault(vault));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /vaults/me — The vault, with collateral locked versus available.
 */
vaultRouter.get("/me", walletAuth, (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }
  return res.json(serializeVault(vaultService.getOrCreateVault(guarantorId)));
});
