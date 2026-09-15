import { Router, Request, Response } from "express";
import {
  ChallengeCapacityError,
  createSession,
  issueChallenge,
  redeemChallenge,
} from "../auth/sessions";
import { isStellarAddress } from "../auth/signature";
import { ensureGuarantor } from "../services/guarantor.service";
import { logAuditEvent } from "../services/audit.service";

export const authRouter = Router();

/**
 * GET /auth/challenge?wallet_address=<G...>
 *
 * A message for the wallet to sign. It names this service, the wallet, a
 * one-time nonce and an expiry, so a signature over it is useless anywhere
 * else and cannot be replayed.
 */
authRouter.get("/challenge", (req: Request, res: Response) => {
  const wallet = String(req.query.wallet_address ?? req.query.wallet ?? "");
  if (!isStellarAddress(wallet)) {
    return res.status(400).json({ error: "wallet_address must be a Stellar account address (G...)" });
  }

  try {
    const challenge = issueChallenge(wallet);
    return res.json({
      wallet_address: challenge.walletAddress,
      challenge: challenge.challenge,
      expires_at: challenge.expiresAt,
    });
  } catch (err) {
    if (err instanceof ChallengeCapacityError) {
      return res.status(503).json({ error: err.message });
    }
    throw err;
  }
});

/**
 * POST /auth/verify  { wallet_address, signature }
 *
 * Exchanges the wallet's signature over an outstanding challenge for a
 * session token. The first sign-in registers the wallet as a guarantor.
 */
authRouter.post("/verify", (req: Request, res: Response) => {
  const wallet = String(req.body?.wallet_address ?? req.body?.walletAddress ?? "");
  const signature = String(req.body?.signature ?? req.body?.signedChallenge ?? "");
  if (!isStellarAddress(wallet) || !signature) {
    return res.status(400).json({ error: "wallet_address and signature are required" });
  }

  if (!redeemChallenge(wallet, signature)) {
    return res.status(401).json({ error: "Invalid or expired signature" });
  }

  const guarantor = ensureGuarantor(wallet);
  const session = createSession(wallet);

  logAuditEvent({
    eventType: "AUTH",
    action: "SIGNED_IN",
    actor: wallet,
    entityType: "guarantor",
    entityId: guarantor.id,
    details: { sessionExpiresAt: session.expiresAt },
  });

  return res.json({
    token: session.token,
    guarantor: {
      id: guarantor.id,
      wallet_address: guarantor.walletAddress,
      display_name: guarantor.displayName ?? null,
      created_at: guarantor.createdAt,
    },
    expires_at: session.expiresAt,
  });
});
