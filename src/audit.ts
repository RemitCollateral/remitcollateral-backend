import { Router, Request, Response } from "express";

export const auditRouter = Router();

// ─── Types ───────────────────────────────────────────────────────────

export interface AuditEvent {
  id: number;
  type: "KYC" | "PROPERTY" | "MORTGAGE" | "MILESTONE" | "SYSTEM";
  action: string;
  actor?: string;       // Stellar address of the user who triggered the event
  entityId?: number;    // Related property/mortgage ID
  details: string;
  timestamp: string;
}

interface CreateEventInput {
  type: AuditEvent["type"];
  action: string;
  actor?: string;
  entityId?: number;
  details: string;
}

// ─── In-Memory Store ─────────────────────────────────────────────────

const auditLog: AuditEvent[] = [];
let eventIdCounter = 1;

// ─── Public Logger (used by other modules) ───────────────────────────

export function logEvent(input: CreateEventInput): AuditEvent {
  const event: AuditEvent = {
    id: eventIdCounter++,
    type: input.type,
    action: input.action,
    actor: input.actor,
    entityId: input.entityId,
    details: input.details,
    timestamp: new Date().toISOString(),
  };

  auditLog.push(event);
  console.log(`[Audit]: [${event.type}] ${event.action} — ${event.details}`);
  return event;
}

// ─── Routes ──────────────────────────────────────────────────────────

// 1. Get full audit log (with optional filters)
auditRouter.get("/", (req: Request, res: Response) => {
  const { type, actor, entityId, limit, offset } = req.query;

  let results = [...auditLog];

  // Apply filters
  if (type) {
    results = results.filter((e) => e.type === type);
  }
  if (actor) {
    results = results.filter((e) => e.actor === actor);
  }
  if (entityId) {
    results = results.filter((e) => e.entityId === parseInt(entityId as string));
  }

  // Sort newest first
  results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Pagination
  const offsetNum = parseInt(offset as string) || 0;
  const limitNum = parseInt(limit as string) || 50;
  const paginated = results.slice(offsetNum, offsetNum + limitNum);

  return res.json({
    total: results.length,
    offset: offsetNum,
    limit: limitNum,
    events: paginated,
  });
});

// 2. Get audit log for a specific entity (property or mortgage)
auditRouter.get("/entity/:entityId", (req: Request, res: Response) => {
  const entityId = parseInt(req.params.entityId);
  const events = auditLog
    .filter((e) => e.entityId === entityId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return res.json({
    entityId,
    total: events.length,
    events,
  });
});

// 3. Get audit log for a specific actor (Stellar address)
auditRouter.get("/actor/:address", (req: Request, res: Response) => {
  const { address } = req.params;
  const events = auditLog
    .filter((e) => e.actor === address)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return res.json({
    actor: address,
    total: events.length,
    events,
  });
});

// 4. Get a summary/count of events by type
auditRouter.get("/summary", (_req: Request, res: Response) => {
  const summary = {
    total: auditLog.length,
    byType: {
      KYC: auditLog.filter((e) => e.type === "KYC").length,
      PROPERTY: auditLog.filter((e) => e.type === "PROPERTY").length,
      MORTGAGE: auditLog.filter((e) => e.type === "MORTGAGE").length,
      MILESTONE: auditLog.filter((e) => e.type === "MILESTONE").length,
      SYSTEM: auditLog.filter((e) => e.type === "SYSTEM").length,
    },
    lastEvent: auditLog.length > 0 ? auditLog[auditLog.length - 1] : null,
  };

  return res.json(summary);
});

// 5. Manually log an event (for external integrations or admin use)
auditRouter.post("/log", (req: Request, res: Response) => {
  const { type, action, actor, entityId, details } = req.body;

  if (!type || !action || !details) {
    return res.status(400).json({ error: "Missing required fields: type, action, details" });
  }

  const validTypes = ["KYC", "PROPERTY", "MORTGAGE", "MILESTONE", "SYSTEM"];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
  }

  const event = logEvent({ type, action, actor, entityId, details });

  return res.status(201).json({
    message: "Event logged successfully",
    event,
  });
});
