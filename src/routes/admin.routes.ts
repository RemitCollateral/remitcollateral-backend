import { Router, Request, Response } from "express";
import { adminAuth } from "../middleware/auth.middleware";
import { sweepLoanLifecycle } from "../services/liquidation.service";
import { logAuditEvent } from "../services/audit.service";

export const adminRouter = Router();

/**
 * POST /admin/liquidation/review
 *
 * Runs the §7.3 lifecycle sweep on demand. §2 lists "triggers liquidation
 * reviews" as an admin capability: the scheduled job in src/jobs runs the
 * same sweep on an interval, and this lets an operator run it immediately
 * rather than waiting for the next tick.
 *
 * The sweep is idempotent with respect to loans that need no action, so
 * running a review out of band is safe.
 */
adminRouter.post("/liquidation/review", adminAuth, async (req: Request, res: Response) => {
  const actor = (req as any).walletAddress as string;

  try {
    const result = await sweepLoanLifecycle();

    logAuditEvent({
      eventType: "SYSTEM",
      action: "LIQUIDATION_REVIEW_TRIGGERED",
      actor,
      details: result,
    });

    return res.json({
      message: "Liquidation review completed",
      ...result,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
