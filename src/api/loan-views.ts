import { beneficiaries, loans } from "../stores";
import { Loan } from "../types";
import { LoanView, serializeLoanWithBeneficiary } from "./serializers";

/** A loan as the API presents it, joined with its beneficiary. */
export function loanView(loan: Loan, now = Date.now()): LoanView {
  const beneficiary = beneficiaries.get(loan.beneficiaryId);
  if (!beneficiary) {
    throw new Error(`Loan ${loan.id} references missing beneficiary ${loan.beneficiaryId}`);
  }
  return serializeLoanWithBeneficiary(loan, beneficiary, now);
}

/** Loans needing attention first: grace, then active with missed payments. */
function attentionRank(view: LoanView): number {
  if (view.status === "grace") return 0;
  if (view.status === "active") return view.missed_installments > 0 ? 1 : 2;
  if (view.status === "defaulted") return 3;
  return 4;
}

/** Every loan a guarantor's collateral backs, most urgent first, then newest first. */
export function loanViewsFor(guarantorId: string, now = Date.now()): LoanView[] {
  return Array.from(loans.values())
    .filter((loan) => loan.guarantorId === guarantorId)
    .map((loan) => loanView(loan, now))
    .sort(
      (a, b) => attentionRank(a) - attentionRank(b) || b.created_at.localeCompare(a.created_at),
    );
}
