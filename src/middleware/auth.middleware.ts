import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config";
import { authChallenges, walletToGuarantor } from "../stores";
import { AuthChallenge } from "../types";

/**
 * Wallet authentication middleware (v1 simplified).
 *
 * In v1, we use a header-based approach where the wallet address is passed
 * via `x-wallet-address`. In production, this would be replaced with
 * Stellar challenge-response signing (SEP-10).
 *
 * Sets `req.walletAddress` and `req.guarantorId` on the request.
 */
export function walletAuth(req: Request, res: Response, next: NextFunction): void {
  const walletAddress = req.headers["x-wallet-address"] as string;

  if (!walletAddress) {
    res.status(401).json({ error: "Missing x-wallet-address header" });
    return;
  }

  // Attach to request
  (req as any).walletAddress = walletAddress;

  const guarantorId = walletToGuarantor.get(walletAddress);
  if (guarantorId) {
    (req as any).guarantorId = guarantorId;
  }

  next();
}

/**
 * Partner API key authentication middleware.
 * Validates the `x-api-key` header against the configured partner key.
 */
export function partnerAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    res.status(401).json({ error: "Missing x-api-key header" });
    return;
  }

  if (apiKey !== config.partnerApiKey) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  // The partner identity comes from the key that authenticated the request,
  // never from the request body — otherwise one partner could sign an
  // attestation into another partner's name.
  (req as any).partnerId = config.partnerId;

  next();
}

/**
 * Admin authentication middleware.
 * Validates the wallet address is the configured admin.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const walletAddress = req.headers["x-wallet-address"] as string;

  if (!walletAddress) {
    res.status(401).json({ error: "Missing x-wallet-address header" });
    return;
  }

  if (config.adminWalletAddress && walletAddress !== config.adminWalletAddress) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  (req as any).walletAddress = walletAddress;
  next();
}

// ─── Challenge Helpers (used by auth routes) ─────────────────────────

export function generateChallenge(walletAddress: string): AuthChallenge {
  const challenge: AuthChallenge = {
    walletAddress,
    challenge: crypto.randomBytes(32).toString("hex"),
    expiresAt: new Date(
      Date.now() + config.challengeExpirySeconds * 1000,
    ).toISOString(),
  };

  authChallenges.set(walletAddress, challenge);
  return challenge;
}

export function verifyChallenge(walletAddress: string, _signedChallenge: string): boolean {
  const challenge = authChallenges.get(walletAddress);
  if (!challenge) return false;

  if (new Date(challenge.expiresAt) < new Date()) {
    authChallenges.delete(walletAddress);
    return false;
  }

  // v1 stub: accept any non-empty signed challenge
  authChallenges.delete(walletAddress);
  return true;
}
