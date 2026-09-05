import express from "express";
import cors from "cors";
import { config } from "./config";
import { logAuditEvent } from "./services/audit.service";
import * as loanService from "./services/loan.service";
import * as vaultService from "./services/vault.service";
import * as liquidationService from "./services/liquidation.service";
import * as remittanceService from "./services/remittance.service";
import { MockOffRampAdapter } from "./adapters/mock-offramp.adapter";
import { MockContractGateway } from "./contracts/mock-gateway";
import { startLifecycleJob, stopLifecycleJob } from "./jobs/lifecycle.job";

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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
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

// ─── Start Server ────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  console.log(`\n🔗 RemitCollateral Backend running on http://localhost:${config.port}`);
  console.log(`📡 Network: ${config.stellarNetwork}`);
  console.log(`❤️  Health: http://localhost:${config.port}/health`);
  console.log(`📋 API: http://localhost:${config.port}/api/v1\n`);

  logAuditEvent({
    eventType: "SYSTEM",
    action: "SERVER_START",
    details: {
      port: config.port,
      network: config.stellarNetwork,
      adapter: "MockOffRampAdapter",
      contractGateway: "MockContractGateway",
    },
  });

  // §7.3 — overdue installments, grace expiry and default are detected on
  // the backend's own clock, so the sweep has to be running for the loan
  // lifecycle to advance at all.
  startLifecycleJob();
});

// ─── Shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[Server]: ${signal} received, shutting down`);
  stopLifecycleJob();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
