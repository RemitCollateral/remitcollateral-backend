import express from "express";
import cors from "cors";
import { config } from "./config";
import { logAuditEvent } from "./services/audit.service";
import { setOffRampAdapter } from "./services/loan.service";
import { MockOffRampAdapter } from "./adapters/mock-offramp.adapter";

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

// ─── Initialize ──────────────────────────────────────────────────────

const app = express();

// Initialize off-ramp adapter (v1: mock)
setOffRampAdapter(new MockOffRampAdapter());

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

app.listen(config.port, () => {
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
    },
  });
});

export default app;
