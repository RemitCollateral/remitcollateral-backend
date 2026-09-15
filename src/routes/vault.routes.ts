import { Router, Request, Response } from "express";
import { walletAuth } from "../middleware/auth.middleware";
import * as vaultService from "../services/vault.service";
import { serializeVault } from "../api/serializers";
import { activeChain } from "../chain/runtime";
import { ChainError } from "../chain/errors";
import { config } from "../config";
import { guarantors, pendingSignatures } from "../stores";
import { logAuditEvent } from "../services/audit.service";
import { PendingSignature } from "../types";

export const vaultRouter = Router();

/** How long a prepared transaction waits for its signature: the SDK's default timeout. */
const SIGNING_WINDOW_MS = 5 * 60 * 1000;

const positiveAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

type Kind = PendingSignature["kind"];

/** Chain mode moves collateral only with the guarantor's own signature. */
function refuseDirectWhenChained(kind: Kind, res: Response): boolean {
  if (!activeChain()) return false;
  res.status(409).json({
    error: `This backend is connected to the contracts, so a ${kind} is signed by your wallet: use /vaults/${kind}/prepare, then /vaults/${kind}/submit`,
  });
  return true;
}

/**
 * POST /vaults/deposit  { amount_usd, tx_hash? } — Record a USDC deposit.
 * Without the contracts connected only; with them, use prepare and submit.
 */
vaultRouter.post("/deposit", walletAuth, async (req: Request, res: Response) => {
  if (refuseDirectWhenChained("deposit", res)) return;
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
  if (refuseDirectWhenChained("withdraw", res)) return;
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
 * POST /vaults/{deposit|withdraw}/prepare  { amount_usd }
 *   → { xdr, hash, network_passphrase }
 *
 * Builds the vault transaction for the guarantor's wallet to sign. A call the
 * contract would refuse, such as withdrawing collateral that is locked, fails
 * here, before the wallet is asked for anything.
 */
function prepareRoute(kind: Kind) {
  return async (req: Request, res: Response) => {
    const chain = activeChain();
    if (!chain) {
      return res.status(409).json({ error: `This backend is not connected to the contracts: use POST /vaults/${kind}` });
    }
    const guarantorId = (req as any).guarantorId as string;
    const wallet = (req as any).walletAddress as string;
    if (!guarantorId || !guarantors.has(guarantorId)) {
      return res.status(404).json({ error: "Guarantor not found. Register first." });
    }

    const amountUsd = req.body?.amount_usd;
    if (!positiveAmount(amountUsd)) {
      return res.status(400).json({ error: "amount_usd must be a positive number" });
    }

    try {
      const prepared =
        kind === "deposit"
          ? await chain.prepareDeposit(wallet, amountUsd)
          : await chain.prepareWithdraw(wallet, amountUsd);

      const now = Date.now();
      for (const [hash, pending] of pendingSignatures) {
        if (Date.parse(pending.expiresAt) <= now) pendingSignatures.delete(hash);
      }
      pendingSignatures.set(prepared.hash, {
        hash: prepared.hash,
        guarantorId,
        kind,
        amountUsd,
        xdr: prepared.xdr,
        expiresAt: new Date(now + SIGNING_WINDOW_MS).toISOString(),
      });

      return res.json({
        xdr: prepared.xdr,
        hash: prepared.hash,
        network_passphrase: config.chain.networkPassphrase,
      });
    } catch (err) {
      if (err instanceof ChainError) return res.status(400).json({ error: err.message });
      throw err;
    }
  };
}

/**
 * POST /vaults/{deposit|withdraw}/submit  { hash, signed_xdr } → VaultSummary
 *
 * Submits what the guarantor's wallet signed. Only a transaction this backend
 * prepared for this guarantor, for this action, and still within its signing
 * window, is accepted, and the chain client refuses it unless the signed
 * envelope is exactly the one prepared.
 */
function submitRoute(kind: Kind) {
  return async (req: Request, res: Response) => {
    const chain = activeChain();
    if (!chain) {
      return res.status(409).json({ error: `This backend is not connected to the contracts: use POST /vaults/${kind}` });
    }
    const guarantorId = (req as any).guarantorId as string;
    const hash = typeof req.body?.hash === "string" ? req.body.hash : "";
    const signedXdr = typeof req.body?.signed_xdr === "string" ? req.body.signed_xdr : "";

    const pending = pendingSignatures.get(hash);
    if (
      !pending ||
      pending.guarantorId !== guarantorId ||
      pending.kind !== kind ||
      Date.parse(pending.expiresAt) <= Date.now()
    ) {
      return res.status(404).json({ error: "No such transaction is waiting for your signature" });
    }

    try {
      const sent = await chain.submitSigned(pending, signedXdr);
      pendingSignatures.delete(hash);

      logAuditEvent({
        eventType: "VAULT",
        action: kind === "deposit" ? "COLLATERAL_DEPOSITED" : "COLLATERAL_WITHDRAWN",
        actor: (req as any).walletAddress,
        entityType: "guarantor",
        entityId: guarantorId,
        details: { amountUsd: pending.amountUsd, txHash: sent.hash },
      });

      return res.json(serializeVault(await vaultService.currentVault(guarantorId)));
    } catch (err) {
      if (err instanceof ChainError) return res.status(400).json({ error: err.message });
      throw err;
    }
  };
}

vaultRouter.post("/deposit/prepare", walletAuth, prepareRoute("deposit"));
vaultRouter.post("/deposit/submit", walletAuth, submitRoute("deposit"));
vaultRouter.post("/withdraw/prepare", walletAuth, prepareRoute("withdraw"));
vaultRouter.post("/withdraw/submit", walletAuth, submitRoute("withdraw"));

/**
 * GET /vaults/me — The vault, with collateral locked versus available. Read
 * from chain when the contracts are connected.
 */
vaultRouter.get("/me", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }
  return res.json(serializeVault(await vaultService.currentVault(guarantorId)));
});
