import { Router, Request, Response } from "express";
import crypto from "crypto";
import { generateChallenge, verifyChallenge } from "../middleware/auth.middleware";

export const authRouter = Router();

/**
 * GET /auth/challenge?wallet=<address>
 * Request a signing challenge for wallet authentication.
 */
authRouter.get("/challenge", (req: Request, res: Response) => {
  const wallet = req.query.wallet as string;

  if (!wallet) {
    return res.status(400).json({ error: "Missing wallet query parameter" });
  }

  const challenge = generateChallenge(wallet);

  return res.json({
    walletAddress: challenge.walletAddress,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
    message: "Sign this challenge with your Stellar wallet to authenticate.",
  });
});

/**
 * POST /auth/verify
 * Submit signed challenge, receive a session token.
 */
authRouter.post("/verify", (req: Request, res: Response) => {
  const { walletAddress, signedChallenge } = req.body;

  if (!walletAddress || !signedChallenge) {
    return res.status(400).json({
      error: "Missing walletAddress or signedChallenge",
    });
  }

  const valid = verifyChallenge(walletAddress, signedChallenge);
  if (!valid) {
    return res.status(401).json({ error: "Invalid or expired challenge" });
  }

  // Generate a session token (simplified for v1)
  const sessionToken = crypto.randomBytes(32).toString("hex");

  return res.json({
    walletAddress,
    sessionToken,
    message: "Authentication successful",
  });
});
