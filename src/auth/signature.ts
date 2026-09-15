import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** Whether `address` is a Stellar account address (G...). */
export function isStellarAddress(address: string): boolean {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

/** Decode a 64-byte ed25519 signature given as base64 or hex. */
function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  if (/^[0-9a-f]{128}$/i.test(s)) return Buffer.from(s, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const bytes = Buffer.from(s, "base64");
  return bytes.length === 64 ? bytes : null;
}

/**
 * Whether `signature` is `wallet`'s signature over `message`.
 *
 * Accepts SEP-53 signed messages, which Freighter's signMessage produces, and
 * falls back to a raw ed25519 signature over the message bytes, which its
 * older signBlob call produces. Anything malformed is simply not valid.
 */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  if (!isStellarAddress(wallet)) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;

  const key = Keypair.fromPublicKey(wallet);
  try {
    if (key.verifyMessage(message, sig)) return true;
  } catch {
    // fall through to the raw form
  }
  try {
    return key.verify(Buffer.from(message, "utf8"), sig);
  } catch {
    return false;
  }
}
