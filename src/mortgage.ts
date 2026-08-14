import { Router, Request, Response } from "express";
import { logEvent } from "./audit";

export const mortgageRouter = Router();

// ─── Types ───────────────────────────────────────────────────────────

interface MortgageApplication {
  id: number;
  propertyId: number;
  borrower: string;           // Stellar address of the diaspora buyer
  requestedAmount: number;    // USDC amount requested
  termMonths: number;         // Loan term in months
  interestRate: number;       // Annual interest rate (e.g. 8.5)
  status: "Applied" | "UnderReview" | "Approved" | "Funded" | "Repaying" | "PaidOff" | "Defaulted";
  monthlyPayment: number;
  totalRepaid: number;
  paymentsRemaining: number;
  disbursements: Disbursement[];
  createdAt: string;
  updatedAt: string;
}

interface Disbursement {
  milestoneStage: number;
  amount: number;
  txHash: string;
  disbursedAt: string;
}

interface RepaymentRecord {
  id: number;
  mortgageId: number;
  amount: number;
  txHash: string;
  paidAt: string;
}

// ─── In-Memory Store ─────────────────────────────────────────────────

const mortgages: Map<number, MortgageApplication> = new Map();
const repayments: RepaymentRecord[] = [];
let mortgageIdCounter = 1;
let repaymentIdCounter = 1;

// ─── Helper ──────────────────────────────────────────────────────────

function calculateMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return principal / termMonths;
  const payment = (principal * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) /
    (Math.pow(1 + monthlyRate, termMonths) - 1);
  return Math.round(payment * 100) / 100;
}

// ─── Routes ──────────────────────────────────────────────────────────

// 1. Apply for a mortgage
mortgageRouter.post("/apply", (req: Request, res: Response) => {
  const { propertyId, borrower, requestedAmount, termMonths, interestRate } = req.body;

  if (!propertyId || !borrower || !requestedAmount || !termMonths) {
    return res.status(400).json({ error: "Missing required fields: propertyId, borrower, requestedAmount, termMonths" });
  }

  const rate = interestRate || 8.5; // Default 8.5% annual rate
  const monthlyPayment = calculateMonthlyPayment(requestedAmount, rate, termMonths);

  const id = mortgageIdCounter++;
  const now = new Date().toISOString();

  const mortgage: MortgageApplication = {
    id,
    propertyId,
    borrower,
    requestedAmount,
    termMonths,
    interestRate: rate,
    status: "Applied",
    monthlyPayment,
    totalRepaid: 0,
    paymentsRemaining: termMonths,
    disbursements: [],
    createdAt: now,
    updatedAt: now,
  };

  mortgages.set(id, mortgage);

  logEvent({
    type: "MORTGAGE",
    action: "APPLICATION_SUBMITTED",
    actor: borrower,
    entityId: id,
    details: `Mortgage application for Property #${propertyId} — $${requestedAmount} USDC over ${termMonths} months`,
  });

  console.log(`[Mortgage]: Application #${id} submitted by ${borrower} for Property #${propertyId}`);
  return res.status(201).json({
    message: "Mortgage application submitted successfully",
    mortgage,
  });
});

// 2. Get mortgage details
mortgageRouter.get("/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const mortgage = mortgages.get(id);

  if (!mortgage) {
    return res.status(404).json({ error: "Mortgage not found" });
  }

  return res.json(mortgage);
});

// 3. List all mortgages (with optional borrower filter)
mortgageRouter.get("/", (req: Request, res: Response) => {
  const { borrower, status } = req.query;
  let results = Array.from(mortgages.values());

  if (borrower) {
    results = results.filter((m) => m.borrower === borrower);
  }
  if (status) {
    results = results.filter((m) => m.status === status);
  }

  return res.json({
    total: results.length,
    mortgages: results,
  });
});

// 4. Approve mortgage (admin/oracle)
mortgageRouter.post("/:id/approve", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const mortgage = mortgages.get(id);

  if (!mortgage) {
    return res.status(404).json({ error: "Mortgage not found" });
  }

  if (mortgage.status !== "Applied" && mortgage.status !== "UnderReview") {
    return res.status(400).json({ error: `Cannot approve mortgage with status: ${mortgage.status}` });
  }

  mortgage.status = "Approved";
  mortgage.updatedAt = new Date().toISOString();
  mortgages.set(id, mortgage);

  logEvent({
    type: "MORTGAGE",
    action: "APPLICATION_APPROVED",
    entityId: id,
    details: `Mortgage #${id} approved for $${mortgage.requestedAmount} USDC`,
  });

  console.log(`[Mortgage]: Application #${id} approved`);
  return res.json({
    message: "Mortgage application approved",
    mortgage,
  });
});

// 5. Disburse funds against a milestone (escrow release simulation)
mortgageRouter.post("/:id/disburse", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { milestoneStage, amount, txHash } = req.body;

  if (milestoneStage === undefined || !amount || !txHash) {
    return res.status(400).json({ error: "Missing milestoneStage, amount, or txHash" });
  }

  const mortgage = mortgages.get(id);

  if (!mortgage) {
    return res.status(404).json({ error: "Mortgage not found" });
  }

  if (mortgage.status !== "Approved" && mortgage.status !== "Funded") {
    return res.status(400).json({ error: `Cannot disburse for mortgage with status: ${mortgage.status}` });
  }

  const disbursement: Disbursement = {
    milestoneStage,
    amount,
    txHash,
    disbursedAt: new Date().toISOString(),
  };

  mortgage.disbursements.push(disbursement);
  mortgage.status = "Funded";
  mortgage.updatedAt = new Date().toISOString();
  mortgages.set(id, mortgage);

  const totalDisbursed = mortgage.disbursements.reduce((sum, d) => sum + d.amount, 0);

  logEvent({
    type: "MORTGAGE",
    action: "FUNDS_DISBURSED",
    entityId: id,
    details: `$${amount} USDC disbursed for milestone stage ${milestoneStage} (total disbursed: $${totalDisbursed})`,
  });

  console.log(`[Mortgage]: $${amount} USDC disbursed for Mortgage #${id}, Stage ${milestoneStage}`);
  return res.json({
    message: "Funds disbursed successfully",
    disbursement,
    totalDisbursed,
    mortgage,
  });
});

// 6. Record a repayment
mortgageRouter.post("/:id/repay", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { amount, txHash } = req.body;

  if (!amount || !txHash) {
    return res.status(400).json({ error: "Missing amount or txHash" });
  }

  const mortgage = mortgages.get(id);

  if (!mortgage) {
    return res.status(404).json({ error: "Mortgage not found" });
  }

  if (mortgage.status !== "Funded" && mortgage.status !== "Repaying") {
    return res.status(400).json({ error: `Cannot accept repayment for mortgage with status: ${mortgage.status}` });
  }

  const repayment: RepaymentRecord = {
    id: repaymentIdCounter++,
    mortgageId: id,
    amount,
    txHash,
    paidAt: new Date().toISOString(),
  };

  repayments.push(repayment);
  mortgage.totalRepaid += amount;
  mortgage.paymentsRemaining = Math.max(0, mortgage.paymentsRemaining - 1);
  mortgage.status = mortgage.paymentsRemaining === 0 ? "PaidOff" : "Repaying";
  mortgage.updatedAt = new Date().toISOString();
  mortgages.set(id, mortgage);

  logEvent({
    type: "MORTGAGE",
    action: "REPAYMENT_RECEIVED",
    actor: mortgage.borrower,
    entityId: id,
    details: `$${amount} USDC repayment received (total repaid: $${mortgage.totalRepaid}, remaining: ${mortgage.paymentsRemaining} payments)`,
  });

  console.log(`[Mortgage]: $${amount} repayment received for Mortgage #${id} (${mortgage.paymentsRemaining} payments remaining)`);
  return res.json({
    message: mortgage.status === "PaidOff" ? "Mortgage fully paid off! 🎉" : "Repayment recorded successfully",
    repayment,
    mortgage,
  });
});

// 7. Get repayment history for a mortgage
mortgageRouter.get("/:id/repayments", (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const mortgage = mortgages.get(id);

  if (!mortgage) {
    return res.status(404).json({ error: "Mortgage not found" });
  }

  const mortgageRepayments = repayments.filter((r) => r.mortgageId === id);

  return res.json({
    mortgageId: id,
    totalRepaid: mortgage.totalRepaid,
    paymentsRemaining: mortgage.paymentsRemaining,
    repayments: mortgageRepayments,
  });
});

// 8. Pool stats — aggregate view of the mortgage pool
mortgageRouter.get("/pool/stats", (_req: Request, res: Response) => {
  const allMortgages = Array.from(mortgages.values());

  const stats = {
    totalApplications: allMortgages.length,
    byStatus: {
      applied: allMortgages.filter((m) => m.status === "Applied").length,
      approved: allMortgages.filter((m) => m.status === "Approved").length,
      funded: allMortgages.filter((m) => m.status === "Funded").length,
      repaying: allMortgages.filter((m) => m.status === "Repaying").length,
      paidOff: allMortgages.filter((m) => m.status === "PaidOff").length,
      defaulted: allMortgages.filter((m) => m.status === "Defaulted").length,
    },
    totalLent: allMortgages.reduce((sum, m) => sum + m.requestedAmount, 0),
    totalRepaid: allMortgages.reduce((sum, m) => sum + m.totalRepaid, 0),
    totalDisbursed: allMortgages.reduce(
      (sum, m) => sum + m.disbursements.reduce((s, d) => s + d.amount, 0),
      0
    ),
  };

  return res.json(stats);
});
