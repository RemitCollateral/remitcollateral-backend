import { Router, Request, Response } from "express";
import { walletAuth, partnerAuth } from "../middleware/auth.middleware";
import { loans, repaymentAttestations } from "../stores";
import * as loanService from "../services/loan.service";
import { serializeAttestation } from "../api/serializers";

export const repaymentRouter = Router();

/**
 * POST /repayments/attest — Submit a signed repayment attestation (partner auth).
 */
repaymentRouter.post("/attest", partnerAuth, async (req: Request, res: Response) => {
  const {
    loanId, installmentNumber, amountLocal, amountUsd,
    beneficiaryPhone, partnerSignature, attestedAt,
  } = req.body;

  if (!loanId || !installmentNumber || !amountLocal || !amountUsd || !partnerSignature) {
    return res.status(400).json({
      error: "Missing required fields: loanId, installmentNumber, amountLocal, amountUsd, partnerSignature",
    });
  }

  try {
    const result = await loanService.processRepaymentAttestation(
      {
        loan_id: loanId,
        installment_number: installmentNumber,
        amount_local: amountLocal,
        amount_usd: amountUsd,
        beneficiary_phone: beneficiaryPhone || "",
        attested_at: attestedAt || new Date().toISOString(),
        partner_signature: partnerSignature,
      },
      (req as any).partnerId as string,
    );

    return res.json({
      message: "Repayment attestation processed successfully",
      loanStatus: result.loan.status,
      collateralReleased: result.collateralReleased,
      loan: result.loan,
    });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /loans/:loanId/repayments — Repayment history for a loan.
 */
repaymentRouter.get(
  "/loans/:loanId/repayments",
  walletAuth,
  (req: Request, res: Response) => {
    const { loanId } = req.params;
    const loan = loans.get(loanId);

    if (!loan || loan.guarantorId !== (req as any).guarantorId) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const attestations = repaymentAttestations.filter(
      (a) => a.loanId === loanId,
    );

    return res.json(
      attestations
        .sort((a, b) => b.attestedAt.localeCompare(a.attestedAt))
        .map(serializeAttestation),
    );
  },
);
