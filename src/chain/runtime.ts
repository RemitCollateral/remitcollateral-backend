import type { SorobanChain } from "./soroban";

/** What the services use of the chain client. Tests can install a fake. */
export type ChainPort = Pick<
  SorobanChain,
  | "vaultPosition"
  | "loan"
  | "requiredLtvBps"
  | "publishReputation"
  | "prepareDeposit"
  | "prepareWithdraw"
  | "prepareOriginate"
  | "submitSigned"
  | "attestRepayment"
  | "flagOverdue"
  | "liquidate"
>;

let active: ChainPort | null = null;

/** Connect the services to the contracts, or disconnect them with null. */
export function setChain(port: ChainPort | null): void {
  active = port;
}

/** The connected chain, or null when the services keep their own accounting. */
export function activeChain(): ChainPort | null {
  return active;
}
