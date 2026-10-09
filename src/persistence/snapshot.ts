import { logger } from "../logging/logger";
import { persistFlushTotal } from "../metrics";
import {
  auditEvents,
  beneficiaries,
  beneficiaryLinks,
  guarantors,
  guarantorToVault,
  loans,
  remittanceRecords,
  repaymentAttestations,
  sessions,
  vaults,
  walletToGuarantor,
} from "../stores";
import { TableName, databaseConfigured, getPool, migrate } from "./database";

const log = logger.child({ component: "persistence" });

/**
 * Durable storage for the in-memory stores.
 *
 * The services read and write the stores synchronously, and mutate the
 * objects they hold in place, so the stores stay the working set. This module
 * keeps a copy of them in PostgreSQL: it loads the copy at startup, and
 * writes whatever changed after each request, after each sweep, on a short
 * timer, and at shutdown. A restart then loses nothing that was written
 * before the last flush.
 *
 * What it does not do: serve queries from the database, or share state
 * between instances. It assumes one instance owns the data, as the lifecycle
 * sweep already does.
 */
interface Collection {
  table: TableName;
  /**
   * Rows never change once written and are never removed, so a flush only
   * has to add the ones it has not seen. Otherwise each flush compares every
   * entity with what was last written.
   */
  appendOnly?: boolean;
  entries(): Array<[string, unknown]>;
  /** Replace the store's contents with `rows`, oldest first. */
  load(rows: Array<{ id: string; data: any }>): void;
}

const byId = <T extends { id: string }>(items: Iterable<T>): Array<[string, unknown]> =>
  Array.from(items, (item) => [item.id, item]);

const COLLECTIONS: Collection[] = [
  {
    table: "guarantors",
    entries: () => byId(guarantors.values()),
    load(rows) {
      guarantors.clear();
      walletToGuarantor.clear();
      for (const { data } of rows) {
        guarantors.set(data.id, data);
        walletToGuarantor.set(data.walletAddress, data.id);
      }
    },
  },
  {
    table: "vaults",
    entries: () => byId(vaults.values()),
    load(rows) {
      vaults.clear();
      guarantorToVault.clear();
      for (const { data } of rows) {
        vaults.set(data.id, data);
        guarantorToVault.set(data.guarantorId, data.id);
      }
    },
  },
  {
    table: "beneficiaries",
    entries: () => byId(beneficiaries.values()),
    load(rows) {
      beneficiaries.clear();
      for (const { data } of rows) beneficiaries.set(data.id, data);
    },
  },
  {
    table: "beneficiary_links",
    entries: () =>
      Array.from(beneficiaryLinks.values()).flatMap((links) =>
        Array.from(links.values(), (link): [string, unknown] => [`${link.guarantorId}:${link.beneficiaryId}`, link]),
      ),
    load(rows) {
      beneficiaryLinks.clear();
      for (const { data } of rows) {
        if (!beneficiaryLinks.has(data.guarantorId)) beneficiaryLinks.set(data.guarantorId, new Map());
        beneficiaryLinks.get(data.guarantorId)!.set(data.beneficiaryId, data);
      }
    },
  },
  {
    table: "loans",
    entries: () => byId(loans.values()),
    load(rows) {
      loans.clear();
      for (const { data } of rows) loans.set(data.id, data);
    },
  },
  {
    table: "remittance_records",
    entries: () => byId(remittanceRecords),
    load(rows) {
      remittanceRecords.length = 0;
      for (const { data } of rows) remittanceRecords.push(data);
    },
  },
  {
    table: "repayment_attestations",
    appendOnly: true,
    entries: () => byId(repaymentAttestations),
    load(rows) {
      repaymentAttestations.length = 0;
      for (const { data } of rows) repaymentAttestations.push(data);
    },
  },
  {
    table: "sessions",
    entries: () => Array.from(sessions, ([key, session]) => [key, session]),
    load(rows) {
      sessions.clear();
      for (const { id, data } of rows) sessions.set(id, data);
    },
  },
  {
    table: "audit_events",
    appendOnly: true,
    entries: () => byId(auditEvents),
    load(rows) {
      auditEvents.length = 0;
      for (const { data } of rows) auditEvents.push(data);
    },
  },
];

/** Oldest first, so arrays come back in the order they were appended. */
const ORDER: Partial<Record<TableName, string>> = {
  remittance_records: "data->>'sentAt', id",
  repayment_attestations: "data->>'createdAt', id",
  audit_events: "data->>'createdAt', id",
};

/** What was last written, per table: id → JSON (or, for append-only tables, just the ids). */
const written = new Map<TableName, Map<string, string>>();

let enabled = false;

/** Replace the stores with what the database holds. */
export async function loadStores(): Promise<void> {
  const pool = getPool();
  // Sessions that expired while the process was down are not worth keeping.
  await pool.query("DELETE FROM sessions WHERE (data->>'expiresAt')::timestamptz < now()");

  for (const collection of COLLECTIONS) {
    const order = ORDER[collection.table] ?? "created_at, id";
    const { rows } = await pool.query<{ id: string; data: any }>(
      `SELECT id, data FROM ${collection.table} ORDER BY ${order}`,
    );
    collection.load(rows);
    written.set(collection.table, new Map(rows.map((row) => [row.id, JSON.stringify(row.data)])));
  }
}

/**
 * Prepare durable storage: migrate the schema, load what is there, and start
 * writing changes back. Returns false, leaving the stores in memory only, when
 * no DATABASE_URL is set.
 */
export async function initPersistence(): Promise<boolean> {
  if (!databaseConfigured()) return false;
  await migrate();
  await loadStores();
  enabled = true;
  timer = setInterval(schedulePersist, FLUSH_INTERVAL_MS);
  timer.unref?.();
  log.info(
    Object.fromEntries(COLLECTIONS.map((c) => [c.table, written.get(c.table)?.size ?? 0])),
    "loaded stores from the database",
  );
  return true;
}

export function persistenceEnabled(): boolean {
  return enabled;
}

// ─── Writing ─────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000;
let timer: NodeJS.Timeout | undefined;

async function flushOnce(): Promise<void> {
  type Change = { table: TableName; upserts: Array<[string, string]>; deletes: string[] };
  const changes: Change[] = [];

  for (const collection of COLLECTIONS) {
    const previous = written.get(collection.table) ?? new Map<string, string>();
    const current = collection.entries();
    const upserts: Array<[string, string]> = [];
    const deletes: string[] = [];

    if (collection.appendOnly) {
      for (const [id, entity] of current) {
        if (!previous.has(id)) upserts.push([id, JSON.stringify(entity)]);
      }
    } else {
      const seen = new Set<string>();
      for (const [id, entity] of current) {
        seen.add(id);
        const json = JSON.stringify(entity);
        if (previous.get(id) !== json) upserts.push([id, json]);
      }
      for (const id of previous.keys()) if (!seen.has(id)) deletes.push(id);
    }

    if (upserts.length > 0 || deletes.length > 0) changes.push({ table: collection.table, upserts, deletes });
  }
  if (changes.length === 0) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const { table, upserts, deletes } of changes) {
      if (upserts.length > 0) {
        await client.query(
          `INSERT INTO ${table} (id, data)
           SELECT * FROM unnest($1::text[], $2::jsonb[])
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [upserts.map(([id]) => id), upserts.map(([, json]) => json)],
        );
      }
      if (deletes.length > 0) {
        await client.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [deletes]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Only now is it known to be stored. The JSON compared against is what was
  // written, so an entity changed during the write is picked up next time.
  for (const { table, upserts, deletes } of changes) {
    const map = written.get(table) ?? new Map<string, string>();
    for (const [id, json] of upserts) map.set(id, json);
    for (const id of deletes) map.delete(id);
    written.set(table, map);
  }
}

/** Writes are serialized: one flush at a time, in the order they were asked for. */
let chain: Promise<void> = Promise.resolve();
let queued = false;

function enqueue(): Promise<void> {
  chain = chain.then(async () => {
    queued = false;
    try {
      await flushOnce();
      persistFlushTotal.inc({ outcome: "success" });
    } catch (err) {
      // Nothing is marked as written, so the next flush retries all of it.
      persistFlushTotal.inc({ outcome: "failure" });
      log.error({ err }, "could not write the stores to the database");
    }
  });
  return chain;
}

/** Ask for changes to be written soon. Cheap to call often: calls made before a flush starts share it. */
export function schedulePersist(): void {
  if (!enabled || queued) return;
  queued = true;
  void enqueue();
}

/** Write everything that has changed, and resolve once it is stored. A no-op without a database. */
export function flushNow(): Promise<void> {
  if (!enabled) return Promise.resolve();
  return enqueue();
}

export async function stopPersistence(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await flushNow();
  enabled = false;
}
