import type { SorobanChain, SignAuthEntry } from "./soroban";

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

let partnerSigner: SignAuthEntry | null = null;

/** Install how the simulated partner co-signs on-chain attestations, or remove it with null. */
export function setPartnerSigner(signer: SignAuthEntry | null): void {
  partnerSigner = signer;
}

/** The partner's co-signer, or null when this deployment holds no partner key. */
export function activePartnerSigner(): SignAuthEntry | null {
  return partnerSigner;
}
