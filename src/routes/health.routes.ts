import { Router, Request, Response } from "express";
import { databaseConfigured, databaseHealthy } from "../persistence";

export const healthRouter = Router();

healthRouter.get("/", async (_req: Request, res: Response) => {
  // Without a database the stores are in memory and there is nothing to check.
  const database = !databaseConfigured() ? "not_configured" : (await databaseHealthy()) ? "ok" : "unavailable";
  const healthy = database !== "unavailable";

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    service: "RemitCollateral Backend",
    version: "1.0.0",
    network: process.env.STELLAR_NETWORK || "testnet",
    database,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
