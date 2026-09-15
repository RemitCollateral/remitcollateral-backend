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
git clone https://github.com/RemitCollateral/remitcollateral-backend.git
cd remitcollateral-backend
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

# Wallet sign-in
AUTH_DOMAIN=RemitCollateral
SESSION_TTL_SECONDS=43200

# The backend's on-chain roles (it holds no contract admin key)
VERIFIER_SECRET_KEY=
ORACLE_SECRET_KEY=
BENEFICIARY_HANDLE_SECRET=
PARTNER_STELLAR_ADDRESS=

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

#### Exchange rates

A loan's principal is set in the beneficiary's local currency and priced in USD at the off-ramp partner's rate when it is originated, since that is the rate the partner pays out at. The rate is recorded on the loan, so its installments and collateral releases are measured against it for the loan's whole life. A currency the partner cannot pay out in is refused. The mock partner quotes fixed indicative rates for NGN, GHS, XOF, KES and USD.

### On-chain roles

The backend acts on chain in exactly three roles, and holds no contract admin key: the contracts' admin is a multisig council.

| Role | Key | What the backend does with it |
|------|-----|-------------------------------|
| Verifier | `VERIFIER_SECRET_KEY` | Co-signs each repayment attestation with the off-ramp partner, and pays the fees for the permissionless liquidation cranks |
| Oracle | `ORACLE_SECRET_KEY` | Publishes each beneficiary's reputation score, which sets the LTV their loans need |
| — | `BENEFICIARY_HANDLE_SECRET` | Keys the HMAC that derives a beneficiary's on-chain handle from their phone number and KYC reference |

Guarantor actions (deposits, withdrawals, originating a loan) must be signed by the guarantor's own wallet, so the backend prepares those transactions, the wallet signs them, and the backend submits them, refusing any signed transaction that is not exactly the one it prepared.

A beneficiary's handle is an HMAC rather than a plain hash because everything on chain is public, and phone numbers and KYC references are short and patterned enough to enumerate. A plain hash would let anyone link on-chain loans to real people.

`src/chain` is the live client for all of this. When the three contract IDs are configured the backend connects to it, and `GET /api/v1/chain` reports `{ enabled: true }`. Vault figures are then read from chain, and deposits and withdrawals are signed by the guarantor's wallet:

1. `POST /api/v1/vaults/deposit/prepare` (or `withdraw/prepare`) with `{ amount_usd }` returns `{ xdr, hash, network_passphrase }`.
2. The wallet signs `xdr`, for example with Freighter's `signTransaction`.
3. `POST /api/v1/vaults/deposit/submit` (or `withdraw/submit`) with `{ hash, signed_xdr }` returns the updated vault.

A prepared transaction is valid for five minutes, only for the guarantor it was prepared for, and only if the signed envelope is exactly what was prepared. Without the contracts configured, `POST /vaults/deposit` and `/withdraw` record collateral in the backend's own accounting, as before. Loans follow the same pattern: `POST /api/v1/loans/prepare` prices the loan at the partner's rate and returns the origination to sign, and `POST /api/v1/loans/submit` sends it, records the loan against its on-chain ID, and has the partner disburse it. Before preparing, the backend publishes the beneficiary's reputation if the chain's copy is out of date, so the collateral the ledger locks is the collateral the backend quoted. Repayments and liquidation are being moved onto the chain next.

The contracts cannot yet cancel a loan whose disbursement fails after its collateral is locked. Such a failure is recorded and audited as `LOAN_DISBURSEMENT_FAILED` for an operator to resolve. `npm run test:chain` exercises the client against a real deployment — set the three contract IDs, `VERIFIER_SECRET_KEY`, `ORACLE_SECRET_KEY`, and `CHAIN_TEST_GUARANTOR_SECRET` and `CHAIN_TEST_PARTNER_SECRET` for funded testnet accounts.

### Running

```bash
# Development (hot-reload)
npm run dev

# Tests
npm test

# Production build & start
npm run build
npm start
```

---

## API Reference (v1)

All endpoints are prefixed with `/api/v1` (except `/health`).

Request and response bodies use snake_case, in the shapes the frontend declares in its `lib/types.ts`: resources are returned directly and lists as JSON arrays, not wrapped in an envelope. Error responses carry the reason as both `error` and `message`.

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
| `GET` | `/api/v1/guarantors/me` | Wallet | The signed-in guarantor's profile |
| `GET` | `/api/v1/guarantors/me/dashboard` | Wallet | Full dashboard data (loans, collateral, risk) |

### Vaults

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v1/vaults/deposit` | Wallet | Record a USDC deposit into guarantor's vault |
| `POST` | `/api/v1/vaults/withdraw` | Wallet | Withdraw unlocked collateral to the signed-in wallet |
| `GET` | `/api/v1/vaults/me` | Wallet | Vault balance breakdown (total, locked, available) |

### Beneficiaries

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/beneficiaries` | Wallet | The beneficiaries you support |
| `POST` | `/api/v1/beneficiaries` | Wallet | Add a beneficiary (phone + partner KYC ref), or link to one another guarantor supports |
| `GET` | `/api/v1/beneficiaries/:id` | Wallet | A beneficiary you support, with their reputation score |
| `GET` | `/api/v1/beneficiaries/:id/reputation` | Wallet | Detailed reputation score breakdown |

A beneficiary is one person, however many guarantors support them. Adding a phone number that is already registered links you to that same person and their shared credit history, but only if the partner KYC reference matches as well; a phone number alone is not enough. Each guarantor keeps their own name for them, and can see, lend to and record remittances for only the beneficiaries on their own list.

### Exchange rates

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/v1/fx/rates/:currency` | Wallet | The off-ramp partner's current rate, in local units per 1 USD |

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
│   ├── chain/              # Live client for the Soroban contracts
│   ├── auth/               # Wallet signature checks, challenges & sessions
│   ├── api/                # Response serializers (the API's wire format) & loan views
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
