import { Pool } from "pg";
import { logger } from "../logging/logger";

const log = logger.child({ component: "database" });

/**
 * Every table holds one entity per row: its id and the entity as JSON. The
 * services keep working on the in-memory stores (see snapshot.ts), so the
 * database is a durable copy of them rather than something queried per request.
 */
export const TABLES = [
  "guarantors",
  "vaults",
  "beneficiaries",
  "beneficiary_links",
  "loans",
  "remittance_records",
  "repayment_attestations",
  "sessions",
  "audit_events",
] as const;

export type TableName = (typeof TABLES)[number];

/** Applied in order, once each. Never edit a migration that has shipped: add a new one. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: TABLES.map(
      (table) => `
        CREATE TABLE IF NOT EXISTS ${table} (
          id         TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
    ).join(";\n"),
  },
  {
    version: 2,
    // Audit history is read newest-first.
    sql: `CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events ((data->>'createdAt'))`,
  },
];

let pool: Pool | null = null;

/** Whether a database is configured. Without one the stores are in memory only. */
export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 10_000,
    });
    // An idle client erroring (the server restarting) must not crash the process.
    pool.on("error", (err) => log.error({ err }, "idle database client error"));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/** Bring the schema up to date. Safe to run from several instances at once. */
export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    // One instance migrates at a time; the others wait, then find nothing to do.
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
        await client.query("COMMIT");
        log.info({ version: migration.version }, "applied migration");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

/** Whether the database answers. Used by /health. */
export async function databaseHealthy(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
