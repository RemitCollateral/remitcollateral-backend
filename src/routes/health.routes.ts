import { Router, Request, Response } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: "RemitCollateral Backend",
    version: "1.0.0",
    network: process.env.STELLAR_NETWORK || "testnet",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
