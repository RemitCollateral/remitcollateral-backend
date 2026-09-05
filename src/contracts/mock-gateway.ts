import crypto from "crypto";
import { ContractGateway } from "./gateway.interface";
import { ContractCallResult, CollateralPosition } from "../types";

/**
 * Mock Contract Gateway (§10)
 *
 * Simulates the Soroban contracts for development and testing. Every call
 * succeeds and returns a simulated transaction hash. The gateway keeps its
 * own view of each vault's position so that the backend's in-memory state
 * can be reconciled against a second source, the way it will be reconciled
 * against the chain once `remitcollateral-contracts` is deployed.
 */
export class MockContractGateway implements ContractGateway {
  private positions: Map<string, CollateralPosition> = new Map();

  // ─── GuarantorVault ────────────────────────────────────────────────

  async depositCollateral(
    vaultId: string,
    guarantorWallet: string,
    amountUsd: number,
    txHash?: string,
  ): Promise<ContractCallResult> {
    const position = this.position(vaultId);
    position.collateralBalance += amountUsd;
    this.recompute(position);

    return this.ok("GuarantorVault", "deposit_collateral", txHash, {
      vaultId,
      guarantorWallet,
      amountUsd,
    });
  }

  async withdrawCollateral(
    vaultId: string,
    destinationAddress: string,
    amountUsd: number,
  ): Promise<ContractCallResult> {
    const position = this.position(vaultId);

    if (amountUsd > position.availableAmount) {
      return this.fail(
        "GuarantorVault",
        "withdraw_collateral",
        `Insufficient unlocked collateral on chain: available ${position.availableAmount}, requested ${amountUsd}`,
      );
    }

    position.collateralBalance -= amountUsd;
    this.recompute(position);

    return this.ok("GuarantorVault", "withdraw_collateral", undefined, {
      vaultId,
      destinationAddress,
      amountUsd,
    });
  }

  async lockCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
  ): Promise<ContractCallResult> {
    const position = this.position(vaultId);

    if (amountUsd > position.availableAmount) {
      return this.fail(
        "GuarantorVault",
        "lock_collateral",
        `Insufficient collateral to lock on chain: available ${position.availableAmount}, requested ${amountUsd}`,
      );
    }

    position.perLoanLocked[loanId] = (position.perLoanLocked[loanId] || 0) + amountUsd;
    this.recompute(position);

    return this.ok("GuarantorVault", "lock_collateral", undefined, {
      vaultId,
      loanId,
      amountUsd,
    });
  }

  async releaseCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
  ): Promise<ContractCallResult> {
    const position = this.position(vaultId);
    const locked = position.perLoanLocked[loanId] || 0;

    position.perLoanLocked[loanId] = Math.max(0, locked - amountUsd);
    this.recompute(position);

    return this.ok("GuarantorVault", "release_collateral", undefined, {
      vaultId,
      loanId,
      amountUsd,
    });
  }

  async getCollateralPosition(vaultId: string): Promise<CollateralPosition> {
    return { ...this.position(vaultId) };
  }

  // ─── LoanLedger ────────────────────────────────────────────────────

  async recordLoan(
    loanId: string,
    vaultId: string,
    principalUsd: number,
    ltvRatio: number,
  ): Promise<ContractCallResult> {
    return this.ok("LoanLedger", "record_loan", undefined, {
      loanId,
      vaultId,
      principalUsd,
      ltvRatio,
    });
  }

  async recordRepayment(
    loanId: string,
    installmentNumber: number,
    amountUsd: number,
  ): Promise<ContractCallResult> {
    return this.ok("LoanLedger", "record_repayment", undefined, {
      loanId,
      installmentNumber,
      amountUsd,
    });
  }

  async closeLoan(
    loanId: string,
    finalStatus: "repaid" | "defaulted",
  ): Promise<ContractCallResult> {
    return this.ok("LoanLedger", "close_loan", undefined, { loanId, finalStatus });
  }

  // ─── LiquidationEngine ─────────────────────────────────────────────

  async liquidateCollateral(
    vaultId: string,
    loanId: string,
    amountUsd: number,
    settlementAddress: string,
  ): Promise<ContractCallResult> {
    const position = this.position(vaultId);
    const locked = position.perLoanLocked[loanId] || 0;

    // Forfeited collateral leaves the vault entirely — it is transferred to
    // the platform settlement address rather than returned to the guarantor.
    position.perLoanLocked[loanId] = Math.max(0, locked - amountUsd);
    position.collateralBalance = Math.max(0, position.collateralBalance - amountUsd);
    this.recompute(position);

    return this.ok("LiquidationEngine", "liquidate_collateral", undefined, {
      vaultId,
      loanId,
      amountUsd,
      settlementAddress,
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private position(vaultId: string): CollateralPosition {
    let position = this.positions.get(vaultId);
    if (!position) {
      position = {
        vaultId,
        collateralBalance: 0,
        lockedAmount: 0,
        availableAmount: 0,
        perLoanLocked: {},
      };
      this.positions.set(vaultId, position);
    }
    return position;
  }

  private recompute(position: CollateralPosition): void {
    position.lockedAmount = Object.values(position.perLoanLocked).reduce(
      (sum, amount) => sum + amount,
      0,
    );
    position.availableAmount = position.collateralBalance - position.lockedAmount;
  }

  private ok(
    contract: ContractCallResult["contract"],
    method: string,
    txHash?: string,
    details?: Record<string, unknown>,
  ): ContractCallResult {
    const result: ContractCallResult = {
      success: true,
      txHash: txHash || `MOCKTX-${crypto.randomBytes(16).toString("hex")}`,
      contract,
      method,
      ledgerAt: new Date().toISOString(),
    };

    console.log(
      `[MockContract]: ${contract}.${method} → ${result.txHash} ${JSON.stringify(details || {})}`,
    );

    return result;
  }

  private fail(
    contract: ContractCallResult["contract"],
    method: string,
    failureReason: string,
  ): ContractCallResult {
    console.log(`[MockContract]: ${contract}.${method} FAILED — ${failureReason}`);

    return {
      success: false,
      txHash: "",
      contract,
      method,
      ledgerAt: new Date().toISOString(),
      failureReason,
    };
  }
}
