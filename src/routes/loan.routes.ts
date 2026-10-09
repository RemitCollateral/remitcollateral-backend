import { Router, Request, Response } from "express";
import { z } from "zod";
import { walletAuth } from "../middleware/auth.middleware";
import { beneficiaries, loans } from "../stores";
import * as loanService from "../services/loan.service";
import { serializeLoan, serializeSchedule } from "../api/serializers";
import { loanView, loanViewsFor } from "../api/loan-views";
import { paginate } from "../api/pagination";
import { validateBody } from "../api/validate";
import { linkOf } from "../services/beneficiary.service";
import { reconcileLoan, reconcileLoans } from "../services/loan-chain.service";
import { activeChain } from "../chain/runtime";
import { ChainError } from "../chain/errors";
import { config } from "../config";
import { OriginateLoanDTO } from "../types";
import { forgetPending, pendingFor, rememberPending } from "../api/pending";

export const loanRouter = Router();

const originateLoanSchema = z.object({
  beneficiary_id: z.string().min(1),
  local_currency: z.string().trim().min(1).transform((v) => v.toUpperCase()),
  principal_local: z.number().finite().positive(),
  installment_count: z.number().int().min(1),
  installment_interval_days: z.number().finite().positive().optional(),
  purpose: z.string().trim().min(1).optional(),
});

/** Check a validated loan request against the guarantor's own beneficiary list. */
function loanRequest(req: Request): { dto: OriginateLoanDTO } | { status: number; error: string } {
  const guarantorId = (req as any).guarantorId as string;
  const body = req.body as z.infer<typeof originateLoanSchema>;

  // Only for a beneficiary on the guarantor's own list.
  if (!linkOf(guarantorId, body.beneficiary_id)) {
    return { status: 404, error: "Beneficiary not found" };
  }
  return {
    dto: {
      beneficiaryId: body.beneficiary_id,
      principalLocal: body.principal_local,
      localCurrency: body.local_currency,
      installmentCount: body.installment_count,
      installmentIntervalDays: body.installment_interval_days,
      purpose: body.purpose,
    },
  };
}

/**
 * POST /loans — Originate a loan, without the contracts connected. With them,
 * the guarantor's wallet signs: use /loans/prepare, then /loans/submit.
 */
loanRouter.post("/", walletAuth, validateBody(originateLoanSchema), async (req: Request, res: Response) => {
  if (activeChain()) {
    return res.status(409).json({
      error: "This backend is connected to the contracts, so a loan is signed by your wallet: use /loans/prepare, then /loans/submit",
    });
  }
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const parsed = loanRequest(req);
  if ("error" in parsed) return res.status(parsed.status).json({ error: parsed.error });

  try {
    return res.status(201).json(serializeLoan(await loanService.originateLoan(guarantorId, parsed.dto)));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /loans/prepare — Price a loan and build its origination for the
 * guarantor's wallet to sign. → { xdr, hash, network_passphrase }
 *
 * The ledger sets the collateral from the beneficiary's reputation as
 * published on chain, so that is brought up to date first: the collateral
 * the chain locks is then the collateral this backend quoted.
 */
loanRouter.post("/prepare", walletAuth, validateBody(originateLoanSchema), async (req: Request, res: Response) => {
  const chain = activeChain();
  if (!chain) {
    return res.status(409).json({ error: "This backend is not connected to the contracts: use POST /loans" });
  }
  if (!config.chain.partnerAddress) {
    return res.status(503).json({ error: "No off-ramp partner address is configured" });
  }
  const guarantorId = (req as any).guarantorId as string;
  const wallet = (req as any).walletAddress as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  const parsed = loanRequest(req);
  if ("error" in parsed) return res.status(parsed.status).json({ error: parsed.error });

  const handle = beneficiaries.get(parsed.dto.beneficiaryId)?.chainHandle;
  if (!handle) {
    return res.status(409).json({ error: "This beneficiary has no on-chain handle yet" });
  }

  try {
    const draft = await loanService.draftChainLoan(guarantorId, parsed.dto);

    const wantedLtvBps = Math.round(draft.ltvRatio * 10_000);
    if ((await chain.requiredLtvBps(handle)) !== wantedLtvBps) {
      const score = beneficiaries.get(parsed.dto.beneficiaryId)!.reputationScore;
      await chain.publishReputation(handle, Math.round(score * 100));
    }

    const prepared = await chain.prepareOriginate({
      wallet,
      beneficiaryHandle: handle,
      partner: config.chain.partnerAddress,
      principalUsd: draft.principalUsd,
      installmentCount: draft.installmentCount,
      intervalSecs: draft.intervalDays * 24 * 60 * 60,
    });
    rememberPending({
      hash: prepared.hash,
      guarantorId,
      kind: "originate",
      amountUsd: draft.principalUsd,
      xdr: prepared.xdr,
      loanDraft: draft,
    });

    return res.json({ xdr: prepared.xdr, hash: prepared.hash, network_passphrase: config.chain.networkPassphrase });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /loans/submit  { hash, signed_xdr } → Loan
 *
 * Sends the origination the guarantor's wallet signed, records the loan
 * against its on-chain ID, and has the partner disburse it.
 */
loanRouter.post("/submit", walletAuth, async (req: Request, res: Response) => {
  const chain = activeChain();
  if (!chain) {
    return res.status(409).json({ error: "This backend is not connected to the contracts: use POST /loans" });
  }
  const guarantorId = (req as any).guarantorId as string;
  const signedXdr = typeof req.body?.signed_xdr === "string" ? req.body.signed_xdr : "";
  const pending = pendingFor(req.body?.hash, guarantorId, "originate");
  if (!pending || !pending.loanDraft) {
    return res.status(404).json({ error: "No such transaction is waiting for your signature" });
  }

  try {
    const sent = await chain.submitSigned(pending, signedXdr);
    forgetPending(pending.hash);

    const onChain = await chain.loan(BigInt(sent.returnValue as bigint));
    if (!onChain) throw new ChainError("The loan was originated but could not be read back from chain");

    const loan = await loanService.recordChainLoan(guarantorId, pending.loanDraft, onChain);
    return res.status(201).json(serializeLoan(loan));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * GET /loans — Every loan the guarantor's collateral backs, most urgent first.
 */
loanRouter.get("/", walletAuth, async (req: Request, res: Response) => {
  const guarantorId = (req as any).guarantorId as string;
  if (!guarantorId) {
    return res.status(404).json({ error: "Guarantor not found. Register first." });
  }

  // With the contracts connected the chain is the authority on each loan's state.
  await reconcileLoans(Array.from(loans.values()).filter((l) => l.guarantorId === guarantorId));

  const { status, limit, offset } = req.query;
  const views = loanViewsFor(guarantorId);
  const filtered = status ? views.filter((view) => view.status === status) : views;
  res.set("X-Total-Count", String(filtered.length));
  return res.json(paginate(filtered, { limit, offset }));
});

/**
 * GET /loans/:id — A loan with its beneficiary and repayment figures.
 */
loanRouter.get("/:id", walletAuth, async (req: Request, res: Response) => {
  const loan = loans.get(req.params.id);
  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    // Not distinguished from "not found": telling a caller that a loan
    // exists but belongs to someone else leaks that it exists at all.
    return res.status(404).json({ error: "Loan not found" });
  }
  await reconcileLoan(loan);
  return res.json(loanView(loan));
});

/**
 * GET /loans/:id/schedule — The installment schedule with payment status.
 */
loanRouter.get("/:id/schedule", walletAuth, async (req: Request, res: Response) => {
  const loan = loans.get(req.params.id);
  if (!loan || loan.guarantorId !== (req as any).guarantorId) {
    return res.status(404).json({ error: "Loan not found" });
  }
  await reconcileLoan(loan);
  return res.json(serializeSchedule(loan.schedule));
});
