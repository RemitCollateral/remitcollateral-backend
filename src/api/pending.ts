import { pendingSignatures } from "../stores";
import { PendingSignature } from "../types";

/** How long a prepared transaction waits for its signature: the SDK's default timeout. */
export const SIGNING_WINDOW_MS = 5 * 60 * 1000;

/** Remember a transaction prepared for a guarantor's wallet to sign. */
export function rememberPending(entry: Omit<PendingSignature, "expiresAt">): void {
  const now = Date.now();
  for (const [hash, pending] of pendingSignatures) {
    if (Date.parse(pending.expiresAt) <= now) pendingSignatures.delete(hash);
  }
  pendingSignatures.set(entry.hash, { ...entry, expiresAt: new Date(now + SIGNING_WINDOW_MS).toISOString() });
}

/**
 * The transaction waiting for this guarantor's signature, for this action,
 * still within its signing window. Anything else is treated as not found.
 */
export function pendingFor(hash: unknown, guarantorId: string, kind: PendingSignature["kind"]): PendingSignature | null {
  const pending = typeof hash === "string" ? pendingSignatures.get(hash) : undefined;
  if (!pending || pending.guarantorId !== guarantorId || pending.kind !== kind) return null;
  if (Date.parse(pending.expiresAt) <= Date.now()) return null;
  return pending;
}

export function forgetPending(hash: string): void {
  pendingSignatures.delete(hash);
}
