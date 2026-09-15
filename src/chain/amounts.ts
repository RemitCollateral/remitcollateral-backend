/** USDC on Stellar has 7 decimal places. The backend works in USD to the cent. */
export const USDC_DECIMALS = 7;
const STROOPS_PER_CENT = 100_000n; // 10^(7 - 2)

/** A USD amount, to the cent, in USDC's smallest unit. */
export function toStroops(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new Error(`Not an amount: ${usd}`);
  return BigInt(Math.round(usd * 100)) * STROOPS_PER_CENT;
}

/** USDC's smallest unit as USD, keeping any sub-cent precision the chain carries. */
export function fromStroops(stroops: bigint | number | string): number {
  return Number(BigInt(stroops)) / 10 ** USDC_DECIMALS;
}
