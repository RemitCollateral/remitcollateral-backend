import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { walletToGuarantor } from "../stores";
import { Session } from "../types";
import { bearerToken, resolveSession } from "../auth/sessions";

function sessionOf(req: Request): Session | null {
  const token = bearerToken(req.headers.authorization);
  return token ? resolveSession(token) : null;
}

/**
 * Wallet authentication. Requires the session token issued by
 * POST /auth/verify, sent as `Authorization: Bearer <token>`.
 *
 * The wallet address comes from the session, which a signature has proven,
 * never from the request itself. Sets `req.walletAddress`, and
 * `req.guarantorId` once the wallet is registered.
 */
export function walletAuth(req: Request, res: Response, next: NextFunction): void {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).json({ error: "Sign in with your wallet first" });
    return;
  }

  (req as any).walletAddress = session.walletAddress;
  const guarantorId = walletToGuarantor.get(session.walletAddress);
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
 * Admin authentication. Requires a signed-in session whose wallet is the
 * configured admin wallet. Fails closed: with no admin wallet configured,
 * nobody is an admin.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const session = sessionOf(req);
  if (!session) {
    res.status(401).json({ error: "Sign in with your wallet first" });
    return;
  }

  if (!config.adminWalletAddress || session.walletAddress !== config.adminWalletAddress) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  (req as any).walletAddress = session.walletAddress;
  next();
}
