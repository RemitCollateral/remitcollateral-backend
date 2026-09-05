import { ContractCallResult, CollateralPosition } from "../types";

/**
 * Contract Gateway Interface (§10)
 *
 * The backend interacts with the Soroban contracts (GuarantorVault,
 * LoanLedger, LiquidationEngine) exclusively through this abstraction,
 * mirroring the off-ramp adapter pattern. V1 ships a mock implementation;
 * when the contracts in `remitcollateral-contracts` are deployed the mock
 * is swapped for a live Stellar SDK implementation without any change to
 * the business logic in `src/services`.
 */
export interface ContractGateway {
  // ─── GuarantorVault ────────────────────────────────────────────────

  /** Credit a confirmed USDC deposit to the guarantor's on-chain vault. */
  depositCollateral(
    vaultId: string,
    guarantorWallet: string,
    amountUsd: number,
    txHash?: string,
  ): Promise<ContractCallResult>;

  /** Transfer unlocked collateral out of the vault to a destination address. */
  withdrawCollateral(
    vaultId: string,
    destinationAddress: string,
    amountUsd: number,
  ): Promise<ContractCallResult>;

  /** Lock collateral against a newly originated loan. */
  lockCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
  ): Promise<ContractCallResult>;

  /** Release previously locked collateral back to the guarantor's free balance. */
  releaseCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
  ): Promise<ContractCallResult>;

  /** Read the on-chain collateral position for a vault. */
  getCollateralPosition(vaultId: string): Promise<CollateralPosition>;

  // ─── LoanLedger ────────────────────────────────────────────────────

  /** Record a loan origination on the ledger contract. */
  recordLoan(
    loanId: string,
    vaultId: string,
    principalUsd: number,
    ltvRatio: number,
  ): Promise<ContractCallResult>;

  /** Record an attested repayment against a loan. */
  recordRepayment(
    loanId: string,
    installmentNumber: number,
    amountUsd: number,
  ): Promise<ContractCallResult>;

  /** Mark a loan as closed on the ledger, either repaid or defaulted. */
  closeLoan(
    loanId: string,
    finalStatus: "repaid" | "defaulted",
  ): Promise<ContractCallResult>;

  // ─── LiquidationEngine ─────────────────────────────────────────────

  /**
   * Forfeit collateral on a defaulted loan and move it to the platform
   * settlement address. In v1 this is a straight transfer — DEX-based
   * liquidation is deferred (§3.5).
   */
  liquidateCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
    settlementAddress: string,
  ): Promise<ContractCallResult>;
}
