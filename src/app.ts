import express from "express";
import cors from "cors";
import * as loanService from "./services/loan.service";
import * as vaultService from "./services/vault.service";
import * as liquidationService from "./services/liquidation.service";
import * as remittanceService from "./services/remittance.service";
import { MockOffRampAdapter } from "./adapters/mock-offramp.adapter";
import { MockContractGateway } from "./contracts/mock-gateway";

// Route modules
import { healthRouter } from "./routes/health.routes";
import { authRouter } from "./routes/auth.routes";
import { guarantorRouter } from "./routes/guarantor.routes";
import { vaultRouter } from "./routes/vault.routes";
import { beneficiaryRouter } from "./routes/beneficiary.routes";
import { loanRouter } from "./routes/loan.routes";
import { repaymentRouter } from "./routes/repayment.routes";
import { remittanceRouter } from "./routes/remittance.routes";
import { auditRouter } from "./routes/audit.routes";
import { adminRouter } from "./routes/admin.routes";

// ─── Initialize ──────────────────────────────────────────────────────

/**
 * The Express application, fully wired but not listening. src/index.ts starts
 * it; tests import it directly and listen on an ephemeral port instead.
 */
const app = express();

// Initialize the off-ramp adapter and the Soroban contract gateway. V1 ships
// mocks for both; swapping in live implementations here is the only change
// needed once the partner integration and remitcollateral-contracts land.
const offRampAdapter = new MockOffRampAdapter();
const contractGateway = new MockContractGateway();

loanService.setOffRampAdapter(offRampAdapter);
remittanceService.setOffRampAdapter(offRampAdapter);
loanService.setContractGateway(contractGateway);
vaultService.setContractGateway(contractGateway);
liquidationService.setContractGateway(contractGateway);

// ─── Middleware ───────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== "test") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────

// Health (no prefix)
app.use("/health", healthRouter);

// All API routes under /api/v1
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/guarantors", guarantorRouter);
app.use("/api/v1/vaults", vaultRouter);
app.use("/api/v1/beneficiaries", beneficiaryRouter);
app.use("/api/v1/loans", loanRouter);
app.use("/api/v1/repayments", repaymentRouter);
app.use("/api/v1/remittances", remittanceRouter);
app.use("/api/v1/audit", auditRouter);
app.use("/api/v1/admin", adminRouter);

// Repayment history is also accessible under /api/v1/loans/:id/repayments
app.use("/api/v1", repaymentRouter);

// ─── Error Handling ──────────────────────────────────────────────────

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(`[Error]: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
