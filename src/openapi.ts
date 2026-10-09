/**
 * Hand-written OpenAPI 3.0 document for /api/v1, served at GET
 * /api/v1/openapi.json. Schemas mirror the exact field lists the frontend's
 * contract test (src/routes/api-contract.test.ts) checks against
 * remitcollateral-frontend/lib/types.ts, not a separate guess at the shape.
 *
 * This is not generated from the route definitions -- Express gives no
 * annotation-based path for that without a much larger dependency. What IS
 * generated and checked is coverage: src/openapi.test.ts enumerates the
 * actually-mounted routes (via app.ts's routeMounts) and fails if this
 * document claims a path/method that doesn't really exist.
 */

const bearerAuth = { bearerAuth: [] as string[] };
const apiKeyAuth = { apiKeyAuth: [] as string[] };

const errorResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

function ok(description: string, schemaRef: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` } } },
  };
}

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "RemitCollateral Backend API",
    version: "1.0.0",
    description:
      "Orchestration API connecting the Soroban contracts and off-ramp partners: originates loans, " +
      "records repayments, releases collateral, and scores beneficiary reputation.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Session token from POST /auth/verify.",
      },
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Off-ramp partner API key.",
      },
    },
    schemas: {
      Guarantor: {
        type: "object",
        properties: {
          id: { type: "string" },
          wallet_address: { type: "string" },
          display_name: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Vault: {
        type: "object",
        properties: {
          id: { type: "string" },
          guarantor_id: { type: "string" },
          collateral_balance: { type: "number" },
          locked_amount: { type: "number" },
          available_amount: { type: "number" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Beneficiary: {
        type: "object",
        properties: {
          id: { type: "string" },
          phone_number: { type: "string" },
          local_kyc_ref: { type: "string" },
          reputation_score: { type: "number", minimum: 0, maximum: 1 },
          display_name: { type: "string", nullable: true },
          local_currency: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Reputation: {
        type: "object",
        properties: {
          beneficiary_id: { type: "string" },
          composite_score: { type: "number" },
          remittance_score: { type: "number" },
          repayment_score: { type: "number" },
          remittance_months_observed: { type: "number" },
          remittance_meets_minimum_history: { type: "boolean" },
          on_time_repayment_rate: { type: "number" },
          loans_completed: { type: "integer" },
          loans_defaulted: { type: "integer" },
          qualified_ltv: { type: "number" },
        },
      },
      ScheduleEntry: {
        type: "object",
        properties: {
          installment: { type: "integer" },
          amount_local: { type: "number" },
          due_at: { type: "string", format: "date-time" },
          paid_at: { type: "string", format: "date-time", nullable: true },
          status: { type: "string", enum: ["due", "upcoming", "paid", "overdue"] },
        },
      },
      Loan: {
        type: "object",
        properties: {
          id: { type: "string" },
          vault_id: { type: "string" },
          beneficiary_id: { type: "string" },
          principal_local: { type: "number" },
          principal_usd: { type: "number" },
          local_currency: { type: "string" },
          ltv_ratio: { type: "number" },
          installment_count: { type: "integer" },
          schedule: { type: "array", items: { $ref: "#/components/schemas/ScheduleEntry" } },
          status: { type: "string", enum: ["active", "grace", "repaid", "defaulted"] },
          grace_expires_at: { type: "string", format: "date-time", nullable: true },
          purpose: { type: "string", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      LoanView: {
        allOf: [
          { $ref: "#/components/schemas/Loan" },
          {
            type: "object",
            properties: {
              beneficiary: { $ref: "#/components/schemas/Beneficiary" },
              total_repaid_local: { type: "number" },
              outstanding_local: { type: "number" },
              collateral_locked_usd: { type: "number" },
              collateral_released_usd: { type: "number" },
              next_installment: { $ref: "#/components/schemas/ScheduleEntry", nullable: true },
              missed_installments: { type: "integer" },
            },
          },
        ],
      },
      Attestation: {
        type: "object",
        properties: {
          id: { type: "string" },
          loan_id: { type: "string" },
          installment_number: { type: "integer" },
          amount_local: { type: "number" },
          amount_usd: { type: "number" },
          attested_by: { type: "string" },
          attested_at: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Remittance: {
        type: "object",
        properties: {
          id: { type: "string" },
          guarantor_id: { type: "string" },
          beneficiary_id: { type: "string" },
          amount_usd: { type: "number" },
          local_amount: { type: "number" },
          local_currency: { type: "string" },
          source: { type: "string", enum: ["self_declared", "partner_reported"] },
          sent_at: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Dashboard: {
        type: "object",
        properties: {
          guarantor: { $ref: "#/components/schemas/Guarantor" },
          vault: { $ref: "#/components/schemas/Vault" },
          loans: { type: "array", items: { $ref: "#/components/schemas/LoanView" } },
          upcoming_installments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                loan_id: { type: "string" },
                beneficiary_name: { type: "string" },
                local_currency: { type: "string" },
                entry: { $ref: "#/components/schemas/ScheduleEntry" },
              },
            },
          },
          at_risk_loans: { type: "array", items: { $ref: "#/components/schemas/LoanView" } },
        },
      },
      PreparedTx: {
        type: "object",
        properties: {
          xdr: { type: "string" },
          hash: { type: "string" },
          network_passphrase: { type: "string" },
        },
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" }, message: { type: "string" } },
      },
    },
  },
  paths: {
    "/health": {
      get: { summary: "Service health", responses: { "200": { description: "OK" } } },
    },
    "/auth/challenge": {
      get: {
        summary: "A one-time message for the wallet to sign",
        parameters: [{ name: "wallet_address", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Challenge issued" }, "400": errorResponse },
      },
    },
    "/auth/verify": {
      post: {
        summary: "Exchange a signed challenge for a session token",
        responses: { "200": { description: "Session issued" }, "401": errorResponse },
      },
    },
    "/guarantors": {
      post: {
        summary: "Register as a guarantor",
        security: [bearerAuth],
        responses: { "201": ok("Guarantor", "Guarantor") },
      },
    },
    "/guarantors/me": {
      get: { summary: "The signed-in guarantor", security: [bearerAuth], responses: { "200": ok("Guarantor", "Guarantor") } },
    },
    "/guarantors/me/dashboard": {
      get: { summary: "Full dashboard data", security: [bearerAuth], responses: { "200": ok("Dashboard", "Dashboard") } },
    },
    "/vaults/deposit": {
      post: { summary: "Record a deposit (without contracts connected)", security: [bearerAuth], responses: { "200": ok("Vault", "Vault"), "400": errorResponse } },
    },
    "/vaults/withdraw": {
      post: { summary: "Withdraw unlocked collateral (without contracts connected)", security: [bearerAuth], responses: { "200": ok("Vault", "Vault"), "400": errorResponse } },
    },
    "/vaults/deposit/prepare": {
      post: { summary: "Prepare a wallet-signed deposit", security: [bearerAuth], responses: { "200": ok("PreparedTx", "PreparedTx"), "400": errorResponse } },
    },
    "/vaults/deposit/submit": {
      post: { summary: "Submit a signed deposit", security: [bearerAuth], responses: { "200": ok("Vault", "Vault"), "400": errorResponse } },
    },
    "/vaults/withdraw/prepare": {
      post: { summary: "Prepare a wallet-signed withdrawal", security: [bearerAuth], responses: { "200": ok("PreparedTx", "PreparedTx"), "400": errorResponse } },
    },
    "/vaults/withdraw/submit": {
      post: { summary: "Submit a signed withdrawal", security: [bearerAuth], responses: { "200": ok("Vault", "Vault"), "400": errorResponse } },
    },
    "/vaults/me": {
      get: { summary: "Vault balance breakdown", security: [bearerAuth], responses: { "200": ok("Vault", "Vault") } },
    },
    "/beneficiaries": {
      get: { summary: "The beneficiaries you support", security: [bearerAuth], responses: { "200": { description: "List", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Beneficiary" } } } } } } },
      post: { summary: "Add a beneficiary", security: [bearerAuth], responses: { "201": ok("Beneficiary", "Beneficiary"), "400": errorResponse, "409": errorResponse } },
    },
    "/beneficiaries/{id}": {
      get: { summary: "A beneficiary you support", security: [bearerAuth], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok("Beneficiary", "Beneficiary"), "404": errorResponse } },
    },
    "/beneficiaries/{id}/reputation": {
      get: { summary: "Detailed reputation breakdown", security: [bearerAuth], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok("Reputation", "Reputation"), "404": errorResponse } },
    },
    "/fx/rates/{currency}": {
      get: { summary: "The partner's current exchange rate", security: [bearerAuth], parameters: [{ name: "currency", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Rate" }, "400": errorResponse } },
    },
    "/loans": {
      get: { summary: "List loans for the authenticated guarantor", security: [bearerAuth], responses: { "200": { description: "List", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/LoanView" } } } } } } },
      post: { summary: "Originate a loan (without contracts connected)", security: [bearerAuth], responses: { "201": ok("Loan", "Loan"), "400": errorResponse, "409": errorResponse } },
    },
    "/loans/prepare": {
      post: { summary: "Price a loan and prepare its origination for signing", security: [bearerAuth], responses: { "200": ok("PreparedTx", "PreparedTx"), "400": errorResponse, "409": errorResponse } },
    },
    "/loans/submit": {
      post: { summary: "Submit a signed loan origination", security: [bearerAuth], responses: { "201": ok("Loan", "Loan"), "400": errorResponse, "404": errorResponse } },
    },
    "/loans/{id}": {
      get: { summary: "A loan with beneficiary and repayment figures", security: [bearerAuth], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": ok("LoanView", "LoanView"), "404": errorResponse } },
    },
    "/loans/{id}/schedule": {
      get: { summary: "Full installment schedule", security: [bearerAuth], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "List", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ScheduleEntry" } } } } } } },
    },
    "/loans/{loanId}/repayments": {
      get: { summary: "Repayment history for a loan", security: [bearerAuth], parameters: [{ name: "loanId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "List", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Attestation" } } } } } } },
    },
    "/repayments/attest": {
      post: { summary: "Submit a repayment attestation signed by the partner's registered Stellar key. Idempotent per (loanId, installmentNumber). Settled on chain when the contracts are connected.", security: [apiKeyAuth], responses: { "200": { description: "Processed" }, "400": errorResponse, "429": errorResponse } },
    },
    "/remittances": {
      get: { summary: "List remittances for the authenticated guarantor", security: [bearerAuth], responses: { "200": { description: "List", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Remittance" } } } } } } },
      post: { summary: "Record a remittance (always recorded as self-declared)", security: [bearerAuth], responses: { "201": ok("Remittance", "Remittance"), "400": errorResponse, "404": errorResponse } },
    },
    "/remittances/ingest": {
      post: { summary: "Batch-import remittance history from the partner", security: [apiKeyAuth], responses: { "200": { description: "Import result" }, "400": errorResponse } },
    },
    "/audit": {
      get: { summary: "Query the audit log", security: [bearerAuth], description: "Admin only.", responses: { "200": { description: "Page of events" }, "403": errorResponse } },
    },
    "/audit/entity/{type}/{id}": {
      get: {
        summary: "Activity log for a specific entity",
        security: [bearerAuth],
        description: "Admin only.",
        parameters: [
          { name: "type", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Events" }, "403": errorResponse },
      },
    },
    "/admin/liquidation/review": {
      post: { summary: "Run the loan lifecycle sweep on demand", security: [bearerAuth], description: "Admin only.", responses: { "200": { description: "Sweep result" }, "403": errorResponse } },
    },
    "/chain": {
      get: { summary: "Whether the contracts are connected", responses: { "200": { description: "Chain status" } } },
    },
  },
};
