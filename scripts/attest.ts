/**
 * Sign and send a repayment attestation as the simulated partner.
 *
 *   PARTNER_SECRET_KEY=S... PARTNER_API_KEY=... API_URL=https://host/api/v1 \
 *     npm run attest -- <loanId> <installment> <amountLocal> <amountUsd>
 *
 * The amounts must be the installment's own, as `GET /loans/:id/schedule` shows them.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { signAttestation } from "../src/chain/attestation";

const [loanId, installment, amountLocal, amountUsd] = process.argv.slice(2);
const { PARTNER_SECRET_KEY, PARTNER_API_KEY, API_URL } = process.env;

if (!loanId || !installment || !amountLocal || !amountUsd || !PARTNER_SECRET_KEY || !PARTNER_API_KEY || !API_URL) {
  console.error("usage: PARTNER_SECRET_KEY=… PARTNER_API_KEY=… API_URL=… npm run attest -- <loanId> <installment> <amountLocal> <amountUsd>");
  process.exit(2);
}

async function main(): Promise<void> {
  const attestedAt = new Date().toISOString();
  const partnerSignature = signAttestation(Keypair.fromSecret(PARTNER_SECRET_KEY), {
    loan_id: loanId,
    installment_number: Number(installment),
    amount_local: Number(amountLocal),
    amount_usd: Number(amountUsd),
    attested_at: attestedAt,
  });

  const res = await fetch(`${API_URL.replace(/\/$/, "")}/repayments/attest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": PARTNER_API_KEY },
    body: JSON.stringify({
      loanId,
      installmentNumber: Number(installment),
      amountLocal: Number(amountLocal),
      amountUsd: Number(amountUsd),
      attestedAt,
      partnerSignature,
    }),
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
