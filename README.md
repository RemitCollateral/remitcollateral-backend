# 🏠 StellarHomes Backend

> Backend service for the StellarHomes platform — a Stellar/Soroban-powered real estate ecosystem enabling diaspora communities to invest in, build, and manage property back home through transparent, milestone-gated smart contracts.

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?style=flat-square&logo=stellar)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey?style=flat-square&logo=express)](https://expressjs.com/)

---

## Overview

StellarHomes bridges the gap between the African diaspora and real estate investment in their home countries. The backend orchestrates:

- **KYC/Identity verification** — Smile ID integration (mocked) for user onboarding
- **Property registry** — Title submission, oracle-based verification, and valuation
- **Mortgage pool** — Application, approval, milestone-gated disbursement, and repayment tracking
- **Construction milestones** — Evidence submission and oracle verification for build progress
- **Audit logging** — Platform-wide activity trail with filterable queries

All financial flows are designed to settle on **Stellar** via **Soroban smart contracts** for escrow, tokenization, and pool management.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Language | TypeScript 5.4 |
| Framework | Express 4.x |
| Blockchain | Stellar SDK 13.x / Soroban |
| Database | PostgreSQL (via `pg`) — currently using in-memory stores for rapid prototyping |

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

# Deployed Soroban Contract Addresses
PROPERTY_REGISTRY_CONTRACT_ID=
MORTGAGE_POOL_CONTRACT_ID=
BUILD_ESCROW_CONTRACT_ID=

# Admin / Oracle configuration
ADMIN_SECRET_KEY=S...
```

### Running

```bash
# Development (hot-reload)
npm run dev

# Production build
npm run build
npm start
```

The server starts at `http://localhost:4000`.

---

## API Reference

### Health & Platform

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check with uptime and network info |
| `GET` | `/stats` | Platform stats and deployed contract addresses |

### KYC / Identity

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/kyc/verify` | Submit KYC verification (Smile ID mock) |
| `GET` | `/api/users/:address` | Get user profile by Stellar address |

### Properties

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/properties/submit` | Submit a new property (Trustee) |
| `GET` | `/api/properties/:id` | Get property details |
| `POST` | `/api/properties/:id/verify-title` | Verify title via Land Registry Oracle |
| `POST` | `/api/properties/:id/valuation` | Set property valuation (Surveyor/Oracle) |

### Milestones

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/properties/:id/milestones/submit` | Submit milestone evidence (Builder/Trustee) |
| `POST` | `/api/properties/:id/milestones/verify` | Verify milestone (Oracle) |

### Mortgages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mortgages/apply` | Submit a mortgage application |
| `GET` | `/api/mortgages/` | List mortgages (filter by `borrower`, `status`) |
| `GET` | `/api/mortgages/:id` | Get mortgage details |
| `POST` | `/api/mortgages/:id/approve` | Approve a mortgage application |
| `POST` | `/api/mortgages/:id/disburse` | Disburse funds against a verified milestone |
| `POST` | `/api/mortgages/:id/repay` | Record a repayment |
| `GET` | `/api/mortgages/:id/repayments` | Get repayment history |
| `GET` | `/api/mortgages/pool/stats` | Aggregate mortgage pool analytics |

### Audit Log

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/audit/` | Query audit log (filter by `type`, `actor`, `entityId`; supports `limit`/`offset`) |
| `GET` | `/api/audit/entity/:entityId` | Activity log for a specific property/mortgage |
| `GET` | `/api/audit/actor/:address` | Activity log for a specific user |
| `GET` | `/api/audit/summary` | Event count breakdown by type |
| `POST` | `/api/audit/log` | Manually log an event |

---

## Project Structure

```
stellar-homes-backend/
├── src/
│   ├── index.ts        # Express entry point, middleware, health endpoints
│   ├── routes.ts       # Core API — KYC, properties, milestones
│   ├── mortgage.ts     # Mortgage lifecycle — apply, approve, disburse, repay
│   └── audit.ts        # Platform-wide activity audit log
├── .env.example        # Environment variable template
├── tsconfig.json       # TypeScript configuration
└── package.json        # Dependencies and scripts
```

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Frontend    │────▶│  Express API     │────▶│  Soroban Contracts  │
│  (Next.js)   │     │  (this repo)     │     │  (Stellar Testnet)  │
└─────────────┘     └──────────────────┘     └─────────────────────┘
                           │
                    ┌──────┴──────┐
                    │  In-Memory  │  ← will migrate to PostgreSQL
                    │   Stores    │
                    └─────────────┘
```

**Smart Contracts (Soroban):**
- `PropertyRegistry` — On-chain title registration and tokenization
- `MortgagePool` — Pooled lending with interest accrual
- `BuildEscrow` — Milestone-gated fund release for construction

---

## Soroban Contract Integration

The backend is designed to interact with three Soroban contracts deployed on Stellar. Contract IDs are configured via environment variables. The current implementation uses in-memory stores to mock contract state, making it easy to run locally without a blockchain dependency.

To connect to live contracts, set the `*_CONTRACT_ID` variables in `.env` and the backend will route calls through the Stellar SDK.

---

## License

MIT

---

<p align="center">Built with ☀️ by <strong>NeonsLabs</strong></p>
