import express from "express";
import cors from "cors";
import helmet from "helmet";
import * as loanService from "./services/loan.service";
import * as vaultService from "./services/vault.service";
import * as liquidationService from "./services/liquidation.service";
import * as remittanceService from "./services/remittance.service";
import { MockOffRampAdapter } from "./adapters/mock-offramp.adapter";
import { MockContractGateway } from "./contracts/mock-gateway";
import { instrumented } from "./contracts/instrumented-gateway";

// Route modules
import { healthRouter } from "./routes/health.routes";
import { metricsRouter } from "./routes/metrics.routes";
import { authRouter } from "./routes/auth.routes";
import { guarantorRouter } from "./routes/guarantor.routes";
import { vaultRouter } from "./routes/vault.routes";
import { beneficiaryRouter } from "./routes/beneficiary.routes";
import { loanRouter } from "./routes/loan.routes";
import { repaymentRouter } from "./routes/repayment.routes";
import { remittanceRouter } from "./routes/remittance.routes";
import { auditRouter } from "./routes/audit.routes";
import { adminRouter } from "./routes/admin.routes";
import { fxRouter } from "./routes/fx.routes";
import { chainRouter } from "./routes/chain.routes";
import { openApiRouter } from "./routes/openapi.routes";
import { config } from "./config";
import { chainFromConfig, partnerSignerFromConfig } from "./chain";
import { setChain, setPartnerSigner } from "./chain/runtime";
import { requestLogging } from "./middleware/request-logging.middleware";
import { logger } from "./logging/logger";

// ─── Initialize ──────────────────────────────────────────────────────

/**
 * The Express application, fully wired but not listening. src/index.ts starts
 * it; tests import it directly and listen on an ephemeral port instead.
 */
const app = express();

// Initialize the off-ramp adapter and the Soroban contract gateway. V1 ships
// mocks for both; swapping in live implementations here is the only change
// needed once the partner integration and remitcollateral-contracts land.
const offRampAdapter = new MockOffRampAdapter();
const contractGateway = instrumented(new MockContractGateway());

loanService.setOffRampAdapter(offRampAdapter);
remittanceService.setOffRampAdapter(offRampAdapter);
loanService.setContractGateway(contractGateway);
vaultService.setContractGateway(contractGateway);
liquidationService.setContractGateway(contractGateway);

// The live contracts, when a deployment is configured. Without one the
// services keep their own accounting, as in development. Tests never reach a
// live network: they run against that accounting, or install a fake chain.
const chainClient = process.env.NODE_ENV === "test" ? null : chainFromConfig();
if (chainClient && !config.chain.beneficiaryHandleSecret) {
  throw new Error("BENEFICIARY_HANDLE_SECRET must be set when the contracts are configured");
}
if (chainClient && !config.chain.partnerAddress) {
  throw new Error("PARTNER_STELLAR_ADDRESS must be set when the contracts are configured");
}
setChain(chainClient);
setPartnerSigner(chainClient ? partnerSignerFromConfig() : null);

// ─── Middleware ───────────────────────────────────────────────────────

app.use(helmet());

// CORS_ALLOWED_ORIGINS unset means "allow any origin" — fine for local
// development, not for anything with real traffic reaching it. Requests
// with no Origin header (server-to-server calls, partner webhooks, curl)
// are not browser requests and are never subject to this check.
if (process.env.NODE_ENV === "production" && config.corsAllowedOrigins.length === 0) {
  console.warn(
    "[Config]: CORS_ALLOWED_ORIGINS is unset in production — accepting browser requests from any origin.",
  );
}
app.use(
  cors(
    config.corsAllowedOrigins.length > 0
      ? {
          origin: (origin, callback) => {
            callback(null, !origin || config.corsAllowedOrigins.includes(origin));
          },
        }
      : undefined,
  ),
);
app.use(express.json());

// Error bodies carry their reason as `message` as well as `error`: every route
// sets `error`, and the frontend reads `message`.
app.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)) {
      const fields = body as Record<string, unknown>;
      if (typeof fields.error === "string" && fields.message === undefined) {
        return json({ ...fields, message: fields.error });
      }
    }
    return json(body);
  }) as typeof res.json;
  next();
});

app.use(requestLogging);

// ─── Routes ──────────────────────────────────────────────────────────

/**
 * The single source of truth for what's mounted where. Exported so the
 * OpenAPI spec's test can enumerate the real routes and fail if the spec
 * drifts from them, rather than mounting routes ad hoc below where nothing
 * outside this file could ever check that list against reality.
 */
export const routeMounts: Array<{ prefix: string; router: express.Router }> = [
  { prefix: "/health", router: healthRouter }, // no /api/v1 prefix
  { prefix: "/metrics", router: metricsRouter }, // no /api/v1 prefix
  { prefix: "/api/v1/auth", router: authRouter },
  { prefix: "/api/v1/guarantors", router: guarantorRouter },
  { prefix: "/api/v1/vaults", router: vaultRouter },
  { prefix: "/api/v1/beneficiaries", router: beneficiaryRouter },
  { prefix: "/api/v1/loans", router: loanRouter },
  { prefix: "/api/v1/repayments", router: repaymentRouter },
  { prefix: "/api/v1/remittances", router: remittanceRouter },
  { prefix: "/api/v1/audit", router: auditRouter },
  { prefix: "/api/v1/admin", router: adminRouter },
  { prefix: "/api/v1/fx", router: fxRouter },
  { prefix: "/api/v1/chain", router: chainRouter },
  { prefix: "/api/v1", router: openApiRouter },
  // Repayment history is also accessible under /api/v1/loans/:id/repayments.
  { prefix: "/api/v1", router: repaymentRouter },
];

for (const { prefix, router } of routeMounts) {
  app.use(prefix, router);
}

// ─── Error Handling ──────────────────────────────────────────────────

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    (req.log ?? logger).error({ err }, "unhandled error");
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
