import { Keypair } from "@stellar/stellar-sdk";
import type { OffRampAttestation } from "../types";

/**
 * What a partner signs to attest a repayment. Every figure that moves
 * collateral is in it, so a signature cannot be reused for a different
 * installment, amount or loan. Amounts are written to the cent, so the partner
 * and the backend agree on the bytes however each formats a number.
 */
export function attestationMessage(a: Pick<OffRampAttestation, "loan_id" | "installment_number" | "amount_local" | "amount_usd" | "attested_at">): string {
  return [
    "RemitCollateral repayment attestation v1",
    `loan: ${a.loan_id}`,
    `installment: ${a.installment_number}`,
    `amount_local: ${Number(a.amount_local).toFixed(2)}`,
    `amount_usd: ${Number(a.amount_usd).toFixed(2)}`,
    `attested_at: ${a.attested_at}`,
  ].join("\n");
}

/** The partner's signature (base64) over `attestationMessage`. */
export function signAttestation(partner: Keypair, a: Parameters<typeof attestationMessage>[0]): string {
  return Buffer.from(partner.sign(Buffer.from(attestationMessage(a), "utf8"))).toString("base64");
}

/** Whether `partnerAddress`'s key signed exactly this attestation. */
export function verifyPartnerSignature(partnerAddress: string, a: OffRampAttestation): boolean {
  try {
    const signature = Buffer.from(a.partner_signature, "base64");
    if (signature.length !== 64) return false;
    return Keypair.fromPublicKey(partnerAddress).verify(Buffer.from(attestationMessage(a), "utf8"), signature);
  } catch {
    return false;
  }
}
