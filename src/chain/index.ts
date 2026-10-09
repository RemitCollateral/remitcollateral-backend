import { Keypair, contract } from "@stellar/stellar-sdk";
import { config } from "../config";
import { SorobanChain } from "./soroban";
import type { SignAuthEntry } from "./soroban";

export { SorobanChain } from "./soroban";
export type { ChainLoan, PreparedTx, SignAuthEntry } from "./soroban";
export { ChainError } from "./errors";
export { beneficiaryHandle } from "./handle";
export { toStroops, fromStroops } from "./amounts";

/** The live chain client, or null when no contract deployment is configured. */
export function chainFromConfig(): SorobanChain | null {
  const { guarantorVault, loanLedger, liquidationEngine } = config.contracts;
  if (!guarantorVault || !loanLedger || !liquidationEngine) return null;

  const key = (secret: string) => (secret ? Keypair.fromSecret(secret) : undefined);
  return new SorobanChain({
    rpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.chain.networkPassphrase,
    contracts: { vault: guarantorVault, ledger: loanLedger, engine: liquidationEngine },
    verifier: key(config.chain.verifierSecretKey),
    oracle: key(config.chain.oracleSecretKey),
  });
}

/**
 * How the simulated partner co-signs on-chain attestations, or null if no
 * PARTNER_SECRET_KEY is set. A key that is not the registered partner's would
 * only produce transactions the ledger refuses, so it fails at startup.
 */
export function partnerSignerFromConfig(): SignAuthEntry | null {
  const secret = config.chain.partnerSecretKey;
  if (!secret) return null;
  const partner = Keypair.fromSecret(secret);
  if (config.chain.partnerAddress && partner.publicKey() !== config.chain.partnerAddress) {
    throw new Error("PARTNER_SECRET_KEY is not the key of PARTNER_STELLAR_ADDRESS");
  }
  return contract.basicNodeSigner(partner, config.chain.networkPassphrase).signAuthEntry as SignAuthEntry;
}
