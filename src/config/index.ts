import dotenv from "dotenv";
import { Networks } from "@stellar/stellar-sdk";

dotenv.config();

/**
 * Read a numeric override, falling back to the documented default when the
 * variable is unset or not a number. A malformed value must not silently
 * become NaN — an NaN LTV would let a loan originate against no collateral
 * at all, since every comparison against NaN is false.
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Config]: ${key}="${raw}" is not a number, using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  stellarNetwork: process.env.STELLAR_NETWORK || "testnet",
  stellarRpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",

  // Soroban contracts
  contracts: {
    guarantorVault: process.env.GUARANTOR_VAULT_CONTRACT_ID || "",
    loanLedger: process.env.LOAN_LEDGER_CONTRACT_ID || "",
    liquidationEngine: process.env.LIQUIDATION_ENGINE_CONTRACT_ID || "",
  },

  // Protocol parameters. The architecture describes the LTV bounds, the
  // safety buffer and the grace period as configurable with the defaults
  // below (§3.1, §3.4, §3.5, §8.3), so each is overridable by environment.
  protocol: {
    defaultLtvRatio: num("BASE_LTV_RATIO", 1.50),       // 150% base LTV
    minLtvRatio: num("MIN_LTV_RATIO", 1.10),            // 110% floor LTV
    ltvReductionFactor: num("LTV_REDUCTION_FACTOR", 0.004), // score * factor = LTV reduction
    safetyBufferRatio: num("SAFETY_BUFFER_RATIO", 0.05),    // retained until 100% repaid
    gracePeriodDays: num("GRACE_PERIOD_DAYS", 7),           // days before default
    remittanceWeight: num("REMITTANCE_WEIGHT", 0.40),   // 40% weight, remittance history
    repaymentWeight: num("REPAYMENT_WEIGHT", 0.60),     // 60% weight, repayment history
    minRemittanceMonths: num("MIN_REMITTANCE_MONTHS", 6), // months needed to affect LTV
    settlementAddress: process.env.SETTLEMENT_ADDRESS || "GSETTLEMENTADDRESS1234567890",
  },

  // Scheduled jobs (§7.3)
  jobs: {
    lifecycleIntervalMinutes: parseInt(
      process.env.LIFECYCLE_SWEEP_INTERVAL_MINUTES || "60",
      10,
    ),
  },

  // Partner auth
  // No default: without a configured key, partner endpoints refuse everyone.
  partnerApiKey: process.env.PARTNER_API_KEY || "",
  partnerId: process.env.PARTNER_ID || "mock-offramp-partner",

  // Auth
  challengeExpirySeconds: 300,   // 5 minutes
  sessionTtlSeconds: num("SESSION_TTL_SECONDS", 12 * 60 * 60), // 12 hours
  /** Named in the sign-in message, so users can see which service they are signing in to. */
  authDomain: process.env.AUTH_DOMAIN || "RemitCollateral",

  // Operator wallet for /admin and /audit, by sign-in. This is not a contract
  // key: the backend holds no contract admin key, since the contracts' admin
  // is a multisig council.
  adminWalletAddress: process.env.ADMIN_WALLET_ADDRESS || "",

  // The backend's own on-chain roles. It co-signs repayment attestations as
  // the verifier, publishes reputation scores as the oracle, and pays the fees
  // for the permissionless liquidation cranks.
  chain: {
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      (["mainnet", "public"].includes(process.env.STELLAR_NETWORK || "") ? Networks.PUBLIC : Networks.TESTNET),
    verifierSecretKey: process.env.VERIFIER_SECRET_KEY || "",
    oracleSecretKey: process.env.ORACLE_SECRET_KEY || "",
    /** Keys the HMAC that turns phone number + KYC reference into a beneficiary's on-chain handle. */
    beneficiaryHandleSecret: process.env.BENEFICIARY_HANDLE_SECRET || "",
  },
};
