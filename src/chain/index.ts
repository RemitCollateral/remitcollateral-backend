import { Keypair } from "@stellar/stellar-sdk";
import { config } from "../config";
import { SorobanChain } from "./soroban";

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
