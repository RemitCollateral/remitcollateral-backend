# 🔗 RemitCollateral Backend

> Backend service for the RemitCollateral platform — Crypto-collateralized lending for local beneficiaries who never touch crypto.

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?style=flat-square&logo=stellar)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey?style=flat-square&logo=express)](https://expressjs.com/)

---

## System Overview

RemitCollateral enables diaspora members to post USDC collateral on Stellar to secure loans for local beneficiaries (relatives, business contacts back home). Beneficiaries receive and repay in local currency via off-ramp partners (mobile money, bank transfer) without needing a crypto wallet or blockchain literacy.

The backend API serves as the orchestration layer between the frontend, Soroban smart contracts, and off-ramp partners.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Language | TypeScript 5.4 |
| Framework | Express 4.x |
| Blockchain | Stellar SDK 17.x / Soroban |
| Off-Ramp | `OffRampAdapter` interface (`MockOffRampAdapter` for dev/testing) |
| Contracts | `ContractGateway` interface (`MockContractGateway` for dev/testing) |
| Database | In-memory data stores (v1 prototype) |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

### Installation

```bash
git clone https://github.com/NeonsLabs/stellar-homes-backend.git
cd stellar-homes-backend
npm install
```

### Environment Setup

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
PORT=4000
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# Soroban Contract Addresses
GUARANTOR_VAULT_CONTRACT_ID=
LOAN_LEDGER_CONTRACT_ID=
LIQUIDATION_ENGINE_CONTRACT_ID=

# Off-Ramp Partner
# Required: partner endpoints refuse every request while it is unset.
PARTNER_API_KEY=<generate one: openssl rand -hex 32>
PARTNER_ID=mock-offramp-partner

# Admin / Settlement
ADMIN_WALLET_ADDRESS=G...
SETTLEMENT_ADDRESS=GSETTLEMENTADDRESS1234567890

# Scheduled jobs
LIFECYCLE_SWEEP_INTERVAL_MINUTES=60
```

#### Protocol parameters

The LTV bounds, safety buffer, grace period and scoring weights are all
overridable. Each falls back to the architecture's documented default when
unset, so an empty `.env` runs the protocol exactly as specified.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BASE_LTV_RATIO` | `1.50` | LTV required of an unknown beneficiary |
| `MIN_LTV_RATIO` | `1.10` | Floor — no reputation score goes below this |
| `LTV_REDUCTION_FACTOR` | `0.004` | LTV reduction per point of reputation score |
| `SAFETY_BUFFER_RATIO` | `0.05` | Collateral retained until repayment completes |
| `GRACE_PERIOD_DAYS` | `7` | Days after a missed installment before default |
| `REMITTANCE_WEIGHT` | `0.40` | Weight of remittance history in the score |
| `REPAYMENT_WEIGHT` | `0.60` | Weight of repayment history in the score |
| `MIN_REMITTANCE_MONTHS` | `6` | History needed before remittances influence LTV |

### Running

```bash
# Development (hot-reload)
npm run dev

# Production build & start
npm run build
npm start
```

---

## API Reference (v1)

All endpoints are prefixed with `/api/v1` (except `/health`).

### Health & Platform

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Service health, uptime, version |

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/auth/challenge?wallet_address=G…` | None | A one-time message for the wallet to sign |
| `POST` | `/api/v1/auth/verify` | None | Exchange the signed message for a session token |

Signing in:

1. `GET /api/v1/auth/challenge?wallet_address=<G…>` returns `{ wallet_address, challenge, expires_at }`. The `challenge` is a message naming this service, the wallet, a one-time nonce and an expiry.
2. The wallet signs `challenge`: Freighter's `signMessage` (SEP-53), or `signBlob` on older versions.
3. `POST /api/v1/auth/verify` with `{ wallet_address, signature }` (base64 or hex) returns `{ token, guarantor, expires_at }`. A wallet's first sign-in registers it as a guarantor.
4. Send `Authorization: Bearer <token>` on every request marked **Wallet** below. Sessions last 12 hours by default (`SESSION_TTL_SECONDS`).

Each challenge works once and expires after five minutes. Endpoints marked **Admin** also require the session's wallet to be `ADMIN_WALLET_ADDRESS`; if that is unset, they refuse everyone.

### Guarantors

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/guarantors` | Wallet | Register as a guarantor |
| `GET` | `/api/v1/guarantors/me` | Wallet | Get own profile and vault summary |
| `GET` | `/api/v1/guarantors/me/dashboard` | Wallet | Full dashboard data (loans, collateral, risk) |

### Vaults

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/vaults/deposit` | Wallet | Record a USDC deposit into guarantor's vault |
| `POST` | `/api/v1/vaults/withdraw` | Wallet | Withdraw unlocked collateral |
| `GET` | `/api/v1/vaults/me` | Wallet | Vault balance breakdown (total, locked, available) |

### Beneficiaries

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/beneficiaries` | Wallet | Register a beneficiary (phone + KYC ref) |
| `GET` | `/api/v1/beneficiaries/:id` | Wallet | Get beneficiary details & reputation score |
| `GET` | `/api/v1/beneficiaries/:id/reputation` | Wallet | Detailed reputation score breakdown |

### Loans

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/loans` | Wallet | Originate loan (checks vault, computes LTV, disburses) |
| `GET` | `/api/v1/loans` | Wallet | List loans for authenticated guarantor |
| `GET` | `/api/v1/loans/:id` | Wallet | Loan details with repayment status |
| `GET` | `/api/v1/loans/:id/schedule` | Wallet | Full installment schedule |

### Repayments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/repayments/attest` | Partner API key | Submit signed repayment attestation |
| `GET` | `/api/v1/loans/:id/repayments` | Wallet | Repayment history for a loan |

### Remittance History

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/remittances` | Wallet | Record a remittance (self-declared / partner) |
| `GET` | `/api/v1/remittances` | Wallet | List remittances for authenticated guarantor |
| `POST` | `/api/v1/remittances/ingest` | Partner API key | Batch-import remittance history from partner |

### Audit Trail

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/audit` | Admin | Query audit log with filters |
| `GET` | `/api/v1/audit/entity/:type/:id` | Admin | Activity log for specific entity |

### Admin

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/admin/liquidation/review` | Admin | Run the loan lifecycle sweep on demand |

---

## Loan Lifecycle

Origination, repayment and collateral release are driven by requests. Default
is not: nobody calls an endpoint when a payment fails to arrive, so overdue
installments, grace-period expiry and default are detected by a scheduled
sweep that runs every `LIFECYCLE_SWEEP_INTERVAL_MINUTES` and once at boot.

```
active ──── installment past due ────▶ grace ──── grace expires ────▶ defaulted
   ▲                                     │
   └────────── attested repayment ───────┘
```

On default, the outstanding principal is forfeited to `SETTLEMENT_ADDRESS`
and collateral above that amount is unlocked and returned to the guarantor —
collateral is posted at 110–150% LTV, so seizing all of it would take more
than the protocol actually lost. The unpaid installments are recorded as
missed, which is what lowers the beneficiary's reputation score; the penalty
is not stored separately, so the score stays reproducible from the underlying
records as the architecture requires.

`POST /api/v1/admin/liquidation/review` runs the same sweep immediately. It
takes no action on loans that need none, so it is safe to run at any time.

> **Single-instance assumption.** The sweep runs in-process. Running more
> than one instance would run it more than once per tick, so a multi-instance
> deployment needs an external scheduler or a lock.

---

## Trust Boundaries

Two rules in the architecture are enforced in code rather than by convention,
and are worth stating because they constrain what callers can do:

- **Remittance source is assigned, not accepted.** Anything recorded through
  `POST /remittances` is stored as `self_declared` and carries 0.0 weight in
  scoring. Only `POST /remittances/ingest`, behind the partner API key, writes
  `partner_reported` records. A guarantor cannot raise a beneficiary's score,
  and so cannot lower their own required LTV, by declaring remittances.
- **Attestations are attributed to the authenticated partner.** The partner
  identifier on a repayment comes from the API key that authenticated the
  request, never from the request body.
- **Wallet identity is proven by a signature.** Protected endpoints take the
  wallet from a session that a signed challenge established, never from the
  request, so one guarantor cannot act as another. The `x-wallet-address`
  header is no longer accepted. Sessions, like all v1 data, live in memory and
  end when the server restarts.

---

## Project Structure

```
remitcollateral-backend/
├── src/
│   ├── config/             # Environment & protocol configuration
│   ├── types/              # Domain entities, DTOs & adapter types
│   ├── adapters/           # Off-ramp adapter interface & MockOffRampAdapter
│   ├── contracts/          # ContractGateway interface & MockContractGateway
│   ├── auth/               # Wallet signature checks, challenges & sessions
│   ├── testing/            # Test helpers (the API on a local port)
│   ├── stores/             # Centralized in-memory data stores
│   ├── services/           # Loan, vault, liquidation, reputation, remittance,
│   │                       #   notification & audit logic
│   ├── jobs/               # Scheduled loan lifecycle sweep
│   ├── middleware/         # Auth middleware (wallet, partner API key, admin)
│   ├── routes/             # Express API route modules
│   └── index.ts            # Main application entry point
├── .env.example
├── tsconfig.json
└── package.json
```

---

## License

MIT

---

<p align="center">Built with ☀️ by <strong>NeonsLabs</strong></p>
