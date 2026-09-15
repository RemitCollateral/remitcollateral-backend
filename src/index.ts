import app from "./app";
import { config } from "./config";
import { logAuditEvent } from "./services/audit.service";
import { startLifecycleJob, stopLifecycleJob } from "./jobs/lifecycle.job";

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
