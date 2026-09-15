import crypto from "crypto";
import { config } from "../config";
import { authChallenges, sessions } from "../stores";
import { AuthChallenge, Session } from "../types";
import { verifyWalletSignature } from "./signature";

/**
 * Outstanding challenges kept per wallet. Asking for a new challenge does not
 * cancel the others, so someone requesting challenges for another person's
 * wallet cannot block that person's sign-in.
 */
const MAX_CHALLENGES_PER_WALLET = 5;

/**
 * Wallets with outstanding challenges, past which new ones are refused until
 * expired challenges are swept. The challenge endpoint needs no login, so this
 * bounds how much memory it can be made to use.
 */
const MAX_WALLETS_WITH_CHALLENGES = 20_000;
const SESSION_SWEEP_AT = 10_000;

export class ChallengeCapacityError extends Error {}

const isLive = (entry: { expiresAt: string }, now = Date.now()) =>
  new Date(entry.expiresAt).getTime() > now;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** The message a wallet signs to sign in: service, wallet, one-time nonce and expiry. */
export function challengeMessage(walletAddress: string, nonce: string, expiresAt: string): string {
  return [
    `Sign in to ${config.authDomain}`,
    "",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

function sweepChallenges(): void {
  const now = Date.now();
  for (const [wallet, pending] of authChallenges) {
    const live = pending.filter((c) => isLive(c, now));
    if (live.length > 0) authChallenges.set(wallet, live);
    else authChallenges.delete(wallet);
  }
}

/** Issue a fresh challenge for `walletAddress` to sign. */
export function issueChallenge(walletAddress: string): AuthChallenge {
  if (!authChallenges.has(walletAddress) && authChallenges.size >= MAX_WALLETS_WITH_CHALLENGES) {
    sweepChallenges();
    if (authChallenges.size >= MAX_WALLETS_WITH_CHALLENGES) {
      throw new ChallengeCapacityError("Too many sign-ins in progress. Try again shortly.");
    }
  }

  const expiresAt = new Date(Date.now() + config.challengeExpirySeconds * 1000).toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const challenge: AuthChallenge = {
    walletAddress,
    challenge: challengeMessage(walletAddress, nonce, expiresAt),
    expiresAt,
  };

  const pending = (authChallenges.get(walletAddress) ?? []).filter((c) => isLive(c));
  pending.push(challenge);
  authChallenges.set(walletAddress, pending.slice(-MAX_CHALLENGES_PER_WALLET));
  return challenge;
}

/**
 * Consume the outstanding challenge that `signature` signs. Each challenge
 * works once. A failed attempt leaves the wallet's challenges in place, so a
 * wrong signature cannot be used to cancel someone else's sign-in.
 */
export function redeemChallenge(walletAddress: string, signature: string): boolean {
  const pending = authChallenges.get(walletAddress);
  if (!pending) return false;

  const now = Date.now();
  const used = pending.findIndex(
    (c) => isLive(c, now) && verifyWalletSignature(walletAddress, c.challenge, signature),
  );
  const remaining = pending.filter((c, i) => i !== used && isLive(c, now));
  if (remaining.length > 0) authChallenges.set(walletAddress, remaining);
  else authChallenges.delete(walletAddress);

  return used !== -1;
}

function sweepSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (!isLive(session, now)) sessions.delete(key);
  }
}

/**
 * Start a session for a wallet that has just proven its key. Only a hash of
 * the token is stored, so the store itself holds nothing usable.
 */
export function createSession(walletAddress: string): { token: string; expiresAt: string } {
  if (sessions.size >= SESSION_SWEEP_AT) sweepSessions();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  sessions.set(hashToken(token), { walletAddress, expiresAt });
  return { token, expiresAt };
}

/** The live session a token belongs to, or null. */
export function resolveSession(token: string): Session | null {
  const key = hashToken(token);
  const session = sessions.get(key);
  if (!session) return null;
  if (!isLive(session)) {
    sessions.delete(key);
    return null;
  }
  return session;
}

/** The session token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+([0-9a-f]{64})$/i.exec((header ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}
