import crypto from "crypto";

/**
 * A beneficiary's on-chain handle: an HMAC-SHA256 of their phone number and
 * partner KYC reference, keyed by a secret only the backend holds.
 *
 * The handle is how loans and reputation name a beneficiary on chain, where
 * everything is public. A plain hash would not do: phone numbers and KYC
 * references are short and patterned enough to enumerate, so anyone could hash
 * candidates until one matched and link on-chain loans to a real person.
 */
export function beneficiaryHandle(phoneNumber: string, localKycRef: string, secret: string): string {
  if (!secret) throw new Error("BENEFICIARY_HANDLE_SECRET is required to derive beneficiary handles");
  return crypto
    .createHmac("sha256", secret)
    .update(`remitcollateral/beneficiary/v1\n${phoneNumber}\n${localKycRef}`)
    .digest("hex");
}
