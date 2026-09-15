import { Vault } from "../types";
import {
  vaults,
  guarantorToVault,
  guarantors,
  generateId,
} from "../stores";
import { ContractGateway } from "../contracts/gateway.interface";
import { logAuditEvent } from "./audit.service";
import { activeChain } from "../chain/runtime";

// ─── Module-level gateway reference ──────────────────────────────────

let contractGateway: ContractGateway | undefined;

export function setContractGateway(gateway: ContractGateway): void {
  contractGateway = gateway;
}

// ─── Service ─────────────────────────────────────────────────────────

/**
 * Get or create a vault for the given guarantor.
 * Each guarantor has exactly one vault (isolated, not pooled).
 */
export function getOrCreateVault(guarantorId: string): Vault {
  const existingVaultId = guarantorToVault.get(guarantorId);
  if (existingVaultId) {
    return vaults.get(existingVaultId)!;
  }

  const vault: Vault = {
    id: generateId(),
    guarantorId,
    collateralBalance: 0,
    lockedAmount: 0,
    createdAt: new Date().toISOString(),
  };

  vaults.set(vault.id, vault);
  guarantorToVault.set(guarantorId, vault.id);

  logAuditEvent({
    eventType: "VAULT",
    action: "VAULT_CREATED",
    actor: guarantorId,
    entityType: "vault",
    entityId: vault.id,
    details: { guarantorId },
  });

  return vault;
}

/**
 * Deposit USDC into the guarantor's vault.
 */
export async function deposit(
  guarantorId: string,
  amount: number,
  txHash?: string,
): Promise<Vault> {
  const vault = getOrCreateVault(guarantorId);

  if (amount <= 0) {
    throw new Error("Deposit amount must be positive");
  }

  if (contractGateway) {
    const guarantor = guarantors.get(guarantorId);
    const result = await contractGateway.depositCollateral(
      vault.id,
      guarantor?.walletAddress || guarantorId,
      amount,
      txHash,
    );
    if (!result.success) {
      throw new Error(`Deposit rejected on chain: ${result.failureReason}`);
    }
  }

  vault.collateralBalance += amount;
  vaults.set(vault.id, vault);

  logAuditEvent({
    eventType: "VAULT",
    action: "COLLATERAL_DEPOSITED",
    actor: guarantorId,
    entityType: "vault",
    entityId: vault.id,
    details: { amount, txHash, newBalance: vault.collateralBalance },
  });

  return vault;
}

/**
 * Withdraw unlocked collateral from the guarantor's vault.
 * Only the unlocked portion (balance - locked) can be withdrawn.
 */
export async function withdraw(
  guarantorId: string,
  amount: number,
  destinationAddress: string,
): Promise<Vault> {
  const vault = getOrCreateVault(guarantorId);
  const available = vault.collateralBalance - vault.lockedAmount;

  if (amount <= 0) {
    throw new Error("Withdrawal amount must be positive");
  }

  if (amount > available) {
    throw new Error(
      `Insufficient unlocked collateral. Available: ${available} USDC, requested: ${amount} USDC`,
    );
  }

  // Settle on chain before debiting locally: if the transfer is rejected the
  // balance must stay as it was, or the guarantor loses collateral that was
  // never actually moved.
  if (contractGateway) {
    const result = await contractGateway.withdrawCollateral(
      vault.id,
      destinationAddress,
      amount,
    );
    if (!result.success) {
      throw new Error(`Withdrawal rejected on chain: ${result.failureReason}`);
    }
  }

  vault.collateralBalance -= amount;
  vaults.set(vault.id, vault);

  logAuditEvent({
    eventType: "VAULT",
    action: "COLLATERAL_WITHDRAWN",
    actor: guarantorId,
    entityType: "vault",
    entityId: vault.id,
    details: { amount, destinationAddress, newBalance: vault.collateralBalance },
  });

  return vault;
}

/**
 * The guarantor's vault as it currently stands. With the contracts connected,
 * the figures are read from chain, which holds the collateral; otherwise they
 * are the backend's own accounting.
 */
export async function currentVault(guarantorId: string): Promise<Vault> {
  const vault = getOrCreateVault(guarantorId);
  const chain = activeChain();
  const wallet = guarantors.get(guarantorId)?.walletAddress;
  if (!chain || !wallet) return vault;

  const position = await chain.vaultPosition(wallet);
  return { ...vault, collateralBalance: position.balanceUsd, lockedAmount: position.lockedUsd };
}

/**
 * Get vault balance breakdown.
 */
export function getBalance(guarantorId: string): {
  total: number;
  locked: number;
  available: number;
} {
  const vault = getOrCreateVault(guarantorId);
  return {
    total: vault.collateralBalance,
    locked: vault.lockedAmount,
    available: vault.collateralBalance - vault.lockedAmount,
  };
}

/**
 * Lock collateral in the vault for a new loan.
 */
export function lockCollateral(vaultId: string, amount: number): void {
  const vault = vaults.get(vaultId);
  if (!vault) {
    throw new Error(`Vault ${vaultId} not found`);
  }

  const available = vault.collateralBalance - vault.lockedAmount;
  if (amount > available) {
    throw new Error(
      `Insufficient collateral to lock. Available: ${available}, required: ${amount}`,
    );
  }

  vault.lockedAmount += amount;
  vaults.set(vaultId, vault);
}

/**
 * Forfeit collateral on a defaulted loan (§3.5).
 *
 * Unlike a release, forfeited collateral leaves the vault entirely: it is
 * transferred to the platform settlement address, so both the locked amount
 * and the total balance are reduced. The caller is responsible for the
 * on-chain transfer via the contract gateway.
 */
export function forfeitCollateral(vaultId: string, amount: number): void {
  const vault = vaults.get(vaultId);
  if (!vault) {
    throw new Error(`Vault ${vaultId} not found`);
  }

  const forfeited = Math.min(amount, vault.lockedAmount, vault.collateralBalance);

  vault.lockedAmount = Math.max(0, vault.lockedAmount - forfeited);
  vault.collateralBalance = Math.max(0, vault.collateralBalance - forfeited);
  vaults.set(vaultId, vault);

  logAuditEvent({
    eventType: "VAULT",
    action: "COLLATERAL_FORFEITED",
    entityType: "vault",
    entityId: vaultId,
    details: {
      requested: amount,
      forfeited,
      newBalance: vault.collateralBalance,
      newLocked: vault.lockedAmount,
    },
  });
}

/**
 * Release collateral from the vault (on repayment).
 */
export function releaseCollateral(vaultId: string, amount: number): void {
  const vault = vaults.get(vaultId);
  if (!vault) {
    throw new Error(`Vault ${vaultId} not found`);
  }

  vault.lockedAmount = Math.max(0, vault.lockedAmount - amount);
  vaults.set(vaultId, vault);

  logAuditEvent({
    eventType: "VAULT",
    action: "COLLATERAL_RELEASED",
    entityType: "vault",
    entityId: vaultId,
    details: { amount, newLocked: vault.lockedAmount },
  });
}
