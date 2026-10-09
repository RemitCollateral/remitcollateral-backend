import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { loans } from "./stores";
import type { LoanStatus } from "./types";

/**
 * Minimal operational metrics (§Phase 4 — sweep failures, gateway errors,
 * and disbursement failures were previously visible only in the audit log).
 * Exported for Prometheus scraping at GET /metrics.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const sweepRunsTotal = new Counter({
  name: "remitcollateral_sweep_runs_total",
  help: "Lifecycle sweep ticks, by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const persistFlushTotal = new Counter({
  name: "remitcollateral_persist_flush_total",
  help: "Writes of the in-memory stores to PostgreSQL, by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const gatewayErrorsTotal = new Counter({
  name: "remitcollateral_contract_gateway_errors_total",
  help: "Contract gateway calls that failed or threw, by method",
  labelNames: ["method"] as const,
  registers: [registry],
});

const LOAN_STATUSES: LoanStatus[] = ["active", "grace", "repaid", "defaulted"];

/**
 * Derived from the loans store on every scrape, rather than incremented or
 * decremented at each transition -- a gauge kept in step by hand drifts the
 * moment one call site forgets to update it.
 */
export const loansByStatus = new Gauge({
  name: "remitcollateral_loans_by_status",
  help: "Current loan count by status",
  labelNames: ["status"] as const,
  registers: [registry],
  collect() {
    const counts = Object.fromEntries(LOAN_STATUSES.map((status) => [status, 0])) as Record<LoanStatus, number>;
    for (const loan of loans.values()) {
      counts[loan.status] = (counts[loan.status] ?? 0) + 1;
    }
    for (const status of LOAN_STATUSES) {
      this.set({ status }, counts[status]);
    }
  },
});
