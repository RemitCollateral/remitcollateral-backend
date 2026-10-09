import type { Server } from "http";
import app from "./app";
import { config } from "./config";
import { logger } from "./logging/logger";
import { logAuditEvent } from "./services/audit.service";
import { startLifecycleJob, stopLifecycleJob, waitForCurrentTick } from "./jobs/lifecycle.job";
import { gracefulShutdown } from "./shutdown";
import { initPersistence, stopPersistence, closePool } from "./persistence";

// ─── Start Server ────────────────────────────────────────────────────

let server: Server | undefined;

async function start(): Promise<void> {
  // The stores are loaded from PostgreSQL before the first request is served,
  // so a restart does not begin from empty. With no DATABASE_URL they stay in
  // memory, as in development.
  const durable = await initPersistence();
  logger.info({ durable }, durable ? "stores are backed by PostgreSQL" : "stores are in memory only");

  server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        network: config.stellarNetwork,
        healthUrl: `http://localhost:${config.port}/health`,
        apiUrl: `http://localhost:${config.port}/api/v1`,
      },
      "RemitCollateral Backend started",
    );

    logAuditEvent({
      eventType: "SYSTEM",
      action: "SERVER_START",
      details: {
        port: config.port,
        network: config.stellarNetwork,
        adapter: "MockOffRampAdapter",
        contractGateway: "MockContractGateway",
        durable,
      },
    });

    // §7.3 — overdue installments, grace expiry and default are detected on
    // the backend's own clock, so the sweep has to be running for the loan
    // lifecycle to advance at all.
    startLifecycleJob();
  });
}

start().catch((err) => {
  // Serving from empty stores because the database was unreachable would look
  // healthy and quietly drop every record, so a failed start stays failed.
  logger.fatal({ err }, "could not start");
  process.exit(1);
});

// ─── Shutdown ────────────────────────────────────────────────────────

/** Wait for `work`, but no longer than `ms`, and never reject. */
function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, (err) => {
      logger.error({ err }, "could not write the stores before exiting");
      done();
    });
  });
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "shutting down");
  // Stop scheduling new ticks immediately; a tick already in progress is
  // waited for below rather than interrupted mid-sweep.
  stopLifecycleJob();

  gracefulShutdown(
    [
      () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
      waitForCurrentTick,
    ],
    config.shutdownTimeoutMs,
  )
    .then(async ({ timedOut }) => {
      // After the last request and sweep, so their changes are included.
      // Bounded, so an unreachable database cannot keep the process from exiting.
      await atMost(stopPersistence().then(closePool), 5_000);
      return timedOut;
    })
    .then((timedOut) => {
      logger.info(
        { signal, timedOut },
        timedOut ? "shutdown timed out waiting for in-flight work, forcing exit" : "shutdown complete",
      );
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "could not finish shutting down cleanly");
      process.exit(1);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
