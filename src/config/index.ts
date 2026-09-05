import dotenv from "dotenv";

dotenv.config();

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

  // Protocol parameters
  protocol: {
    defaultLtvRatio: 1.50,       // 150% base LTV
    minLtvRatio: 1.10,           // 110% floor LTV
    ltvReductionFactor: 0.004,   // score * factor = LTV reduction
    safetyBufferRatio: 0.05,     // 5% retained safety buffer until 100% repaid
    gracePeriodDays: 7,          // 7 days grace period before default
    remittanceWeight: 0.40,      // 40% weight for remittance history score
    repaymentWeight: 0.60,       // 60% weight for repayment history score
    minRemittanceMonths: 6,      // minimum months of history to influence LTV
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
  partnerApiKey: process.env.PARTNER_API_KEY || "dev-partner-key-v1",

  // Auth
  challengeExpirySeconds: 300,   // 5 minutes

  // Admin secret
  adminSecretKey: process.env.ADMIN_SECRET_KEY || "",
  adminWalletAddress: process.env.ADMIN_WALLET_ADDRESS || "",
};
