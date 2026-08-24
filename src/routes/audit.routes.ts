import { Router, Request, Response } from "express";
import { adminAuth } from "../middleware/auth.middleware";
import { queryAuditEvents } from "../services/audit.service";
import { auditEvents } from "../stores";

export const auditRouter = Router();

/**
 * GET /audit — Query audit log with filters (admin auth).
 */
auditRouter.get("/", adminAuth, (req: Request, res: Response) => {
  const { eventType, actor, entityType, entityId, limit, offset } = req.query;

  const result = queryAuditEvents({
    eventType: eventType as string,
    actor: actor as string,
    entityType: entityType as string,
    entityId: entityId as string,
    limit: limit ? parseInt(limit as string) : undefined,
    offset: offset ? parseInt(offset as string) : undefined,
  });

  return res.json({
    ...result,
    limit: limit ? parseInt(limit as string) : 50,
    offset: offset ? parseInt(offset as string) : 0,
  });
});

/**
 * GET /audit/entity/:type/:id — Activity log for a specific entity.
 */
auditRouter.get("/entity/:type/:id", adminAuth, (req: Request, res: Response) => {
  const { type, id } = req.params;

  const events = auditEvents
    .filter((e) => e.entityType === type && e.entityId === id)
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  return res.json({
    entityType: type,
    entityId: id,
    total: events.length,
    events,
  });
});
