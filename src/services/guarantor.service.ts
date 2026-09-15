import { Guarantor } from "../types";
import { guarantors, walletToGuarantor, generateId } from "../stores";
import { logAuditEvent } from "./audit.service";
import * as vaultService from "./vault.service";

/**
 * Register a wallet as a guarantor, with its vault. The caller must already
 * have checked that the wallet is not registered.
 */
export function createGuarantor(walletAddress: string, displayName?: string): Guarantor {
  const guarantor: Guarantor = {
    id: generateId(),
    walletAddress,
    displayName,
    createdAt: new Date().toISOString(),
  };

  guarantors.set(guarantor.id, guarantor);
  walletToGuarantor.set(walletAddress, guarantor.id);
  vaultService.getOrCreateVault(guarantor.id);

  logAuditEvent({
    eventType: "GUARANTOR",
    action: "GUARANTOR_REGISTERED",
    actor: walletAddress,
    entityType: "guarantor",
    entityId: guarantor.id,
    details: { displayName },
  });

  return guarantor;
}

/**
 * The wallet's guarantor record, registering it the first time the wallet
 * signs in. A signed challenge has already proven the wallet's key.
 */
export function ensureGuarantor(walletAddress: string): Guarantor {
  const id = walletToGuarantor.get(walletAddress);
  const existing = id ? guarantors.get(id) : undefined;
  return existing ?? createGuarantor(walletAddress);
}
