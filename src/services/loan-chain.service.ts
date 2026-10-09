import { activeChain } from "../chain/runtime";
import type { ChainLoan } from "../chain/soroban";
import { logger } from "../logging/logger";
import { loans } from "../stores";
import { Loan } from "../types";
import { logAuditEvent } from "./audit.service";

const log = logger.child({ component: "loan-chain" });

/** The parts of a loan the chain is the authority on, as the chain currently holds them. */
function chainView(loan: Loan, onChain: ChainLoan) {
  return {
    status: onChain.status,
    collateralReleasedUsd: onChain.collateralReleasedUsd,
    graceExpiresAt: onChain.status === "grace" && onChain.graceExpiresAt ? onChain.graceExpiresAt.toISOString() : undefined,
    installmentsRepaid: onChain.status === "repaid" ? loan.installmentCount : onChain.installmentsPaid,
  };
}

/** What the backend's own record says, in the same terms as `chainView`. */
function localView(loan: Loan) {
  return {
    status: loan.status,
    collateralReleasedUsd: loan.collateralReleasedUsd,
    graceExpiresAt: loan.graceExpiresAt,
    installmentsRepaid: loan.schedule.filter((s) => s.status === "repaid").length,
  };
}

const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Make the backend's record of a loan match the chain, which holds the
 * collateral and so has the final say on status, release and schedule.
 * Returns the fields that differed, for the caller to decide whether that was
 * expected (it just caused the change) or drift (it did not).
 */
export function applyChainState(loan: Loan, onChain: ChainLoan, repaidAt: string = new Date().toISOString()): string[] {
  const chain = chainView(loan, onChain);
  const local = localView(loan);
  const changed: string[] = [];

  if (local.status !== chain.status) changed.push("status");
  if (!sameMoney(local.collateralReleasedUsd, chain.collateralReleasedUsd)) changed.push("collateralReleasedUsd");
  if (local.graceExpiresAt !== chain.graceExpiresAt) changed.push("graceExpiresAt");
  if (local.installmentsRepaid !== chain.installmentsRepaid) changed.push("installmentsRepaid");
  if (changed.length === 0) return changed;

  loan.status = chain.status;
  loan.collateralReleasedUsd = chain.collateralReleasedUsd;
  loan.graceExpiresAt = chain.graceExpiresAt;
  for (const item of loan.schedule) {
    if (item.installmentNumber <= chain.installmentsRepaid && item.status !== "repaid") {
      item.status = "repaid";
      item.repaidAt = repaidAt;
    }
  }
  loan.updatedAt = new Date().toISOString();
  loans.set(loan.id, loan);
  return changed;
}

/**
 * Read a loan from chain and bring the backend's record into line with it,
 * recording any difference as drift: a change the backend did not itself make
 * means its records and the chain disagreed, which an operator should know.
 * The chain wins either way. Without the contracts connected, or if the chain
 * cannot be read, the loan is left as it is.
 */
export async function reconcileLoan(loan: Loan): Promise<Loan> {
  const chain = activeChain();
  if (!chain || !loan.chainLoanId) return loan;

  let onChain: ChainLoan | null;
  try {
    onChain = await chain.loan(BigInt(loan.chainLoanId));
  } catch (err) {
    log.warn({ err, loanId: loan.id }, "could not read the loan from chain, using the backend's record");
    return loan;
  }
  if (!onChain) {
    logAuditEvent({
      eventType: "SYSTEM",
      action: "LOAN_CHAIN_DRIFT",
      entityType: "loan",
      entityId: loan.id,
      details: { chainLoanId: loan.chainLoanId, problem: "the chain has no such loan" },
    });
    return loan;
  }

  const before = localView(loan);
  const changed = applyChainState(loan, onChain);
  if (changed.length > 0) {
    logAuditEvent({
      eventType: "SYSTEM",
      action: "LOAN_CHAIN_DRIFT",
      entityType: "loan",
      entityId: loan.id,
      details: { chainLoanId: loan.chainLoanId, fields: changed, backendHad: before, chainHas: chainView(loan, onChain) },
    });
  }
  return loan;
}

/** Reconcile many loans, a few chain reads at a time. */
export async function reconcileLoans(list: Loan[], concurrency = 5): Promise<void> {
  const queue = list.filter((l) => l.chainLoanId);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let loan = queue.shift(); loan; loan = queue.shift()) await reconcileLoan(loan);
  });
  await Promise.all(workers);
}
