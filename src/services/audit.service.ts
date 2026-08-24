import { AuditEvent, AuditEventType } from "../types";
import { auditEvents, generateId } from "../stores";

// ─── Input ───────────────────────────────────────────────────────────

export interface LogAuditInput {
  eventType: AuditEventType;
  action: string;
  actor?: string;
  entityType?: string;
  entityId?: string;
  details: Record<string, any> | string;
}

// ─── Service ─────────────────────────────────────────────────────────

export function logAuditEvent(input: LogAuditInput): AuditEvent {
  const event: AuditEvent = {
    id: generateId(),
    eventType: input.eventType,
    action: input.action,
    actor: input.actor,
    entityType: input.entityType,
    entityId: input.entityId,
    details: input.details,
    createdAt: new Date().toISOString(),
  };

  auditEvents.push(event);

  const detailStr = typeof event.details === "string"
    ? event.details
    : JSON.stringify(event.details);

  console.log(`[Audit]: [${event.eventType}] ${event.action} — ${detailStr}`);
  return event;
}

export function queryAuditEvents(filters: {
  eventType?: string;
  actor?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}): { total: number; events: AuditEvent[] } {
  let results = [...auditEvents];

  if (filters.eventType) {
    results = results.filter((e) => e.eventType === filters.eventType);
  }
  if (filters.actor) {
    results = results.filter((e) => e.actor === filters.actor);
  }
  if (filters.entityType) {
    results = results.filter((e) => e.entityType === filters.entityType);
  }
  if (filters.entityId) {
    results = results.filter((e) => e.entityId === filters.entityId);
  }

  // Newest first
  results.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const offset = filters.offset || 0;
  const limit = filters.limit || 50;
  const paginated = results.slice(offset, offset + limit);

  return { total: results.length, events: paginated };
}
