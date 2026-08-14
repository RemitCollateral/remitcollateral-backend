import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { router as apiRouter } from "./routes";
import { mortgageRouter } from "./mortgage";
import { auditRouter, logEvent } from "./audit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "StellarHomes Backend",
    version: "1.0.0",
    network: process.env.STELLAR_NETWORK || "testnet",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Platform stats
app.get("/stats", (_req, res) => {
  const stats = {
    platform: "StellarHomes",
    network: process.env.STELLAR_NETWORK || "testnet",
    contracts: {
      propertyRegistry: process.env.PROPERTY_REGISTRY_CONTRACT_ID || "not deployed",
      mortgagePool: process.env.MORTGAGE_POOL_CONTRACT_ID || "not deployed",
      buildEscrow: process.env.BUILD_ESCROW_CONTRACT_ID || "not deployed",
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  res.json(stats);
});

// API Routes
app.use("/api", apiRouter);
app.use("/api/mortgages", mortgageRouter);
app.use("/api/audit", auditRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[Error]: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n🏠 StellarHomes Backend running on http://localhost:${PORT}`);
  console.log(`📡 Network: ${process.env.STELLAR_NETWORK || "testnet"}`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);

  logEvent({
    type: "SYSTEM",
    action: "SERVER_START",
    details: `Server started on port ${PORT}`,
  });
});

export default app;
