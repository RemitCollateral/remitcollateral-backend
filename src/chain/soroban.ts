import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  contract,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { fromStroops, toStroops } from "./amounts";
import { ChainError, ContractName, chainErrorFrom } from "./errors";

export interface ChainOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: Record<ContractName, string>;
  /** Co-signs repayment attestations and pays for the cranks. */
  verifier?: Keypair;
  /** Publishes reputation scores. */
  oracle?: Keypair;
}

/** A transaction built for a wallet to sign. Its hash does not change when signed. */
export interface PreparedTx {
  xdr: string;
  hash: string;
}

export type LoanStatus = "active" | "grace" | "repaid" | "defaulted";

export interface ChainLoan {
  id: bigint;
  guarantor: string;
  beneficiaryHandle: string;
  partner: string;
  principalUsd: number;
  ltvBps: number;
  collateralLockedUsd: number;
  collateralReleasedUsd: number;
  installmentCount: number;
  intervalSecs: number;
  originatedAt: Date;
  installmentsPaid: number;
  totalRepaidUsd: number;
  nextDue: Date;
  graceExpiresAt: Date | null;
  status: LoanStatus;
}

export type SignAuthEntry = NonNullable<contract.ClientOptions["signAuthEntry"]>;
type Invocation = contract.AssembledTransaction<any>;

/**
 * Check that a wallet signed exactly the transaction that was prepared for it.
 *
 * A transaction's hash covers everything but its signatures, so it is the same
 * before and after signing. A signed envelope whose hash differs is a
 * different transaction, and is refused before it reaches the network.
 */
export function assertSameTransaction(
  expectedHash: string,
  signedXdr: string,
  networkPassphrase: string,
): Transaction {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new ChainError("That is not a valid signed transaction");
  }
  if (tx instanceof FeeBumpTransaction) {
    throw new ChainError("Fee-bump transactions are not accepted here");
  }
  if (Buffer.from(tx.hash()).toString("hex") !== expectedHash) {
    throw new ChainError("The signed transaction is not the one that was prepared");
  }
  if (tx.signatures.length === 0) {
    throw new ChainError("The transaction has not been signed");
  }
  return tx;
}

const secs = (value: unknown) => new Date(Number(value) * 1000);

/**
 * The live client for the three RemitCollateral contracts.
 *
 * It does only what the backend is entitled to do on chain: read state, sign
 * as the verifier and the oracle, pay for the permissionless cranks, and
 * prepare and submit transactions that a guarantor's own wallet signs.
 */
export class SorobanChain {
  private specs = new Map<string, contract.Spec>();

  constructor(private readonly opts: ChainOptions) {}

  // ─── Reads ─────────────────────────────────────────────────────────

  /** A guarantor's vault: total collateral, the part locked, and the part free. */
  async vaultPosition(wallet: string): Promise<{ balanceUsd: number; lockedUsd: number; availableUsd: number }> {
    const vault = await this.read<{ collateral_balance: bigint; locked_amount: bigint }>("vault", "get_vault", {
      guarantor: wallet,
    });
    const balanceUsd = fromStroops(vault.collateral_balance);
    const lockedUsd = fromStroops(vault.locked_amount);
    return { balanceUsd, lockedUsd, availableUsd: balanceUsd - lockedUsd };
  }

  async loan(loanId: bigint): Promise<ChainLoan | null> {
    const raw = await this.read<any>("ledger", "get_loan", { loan_id: loanId });
    if (!raw) return null;
    return {
      id: BigInt(raw.id),
      guarantor: raw.guarantor,
      beneficiaryHandle: Buffer.from(raw.beneficiary).toString("hex"),
      partner: raw.partner,
      principalUsd: fromStroops(raw.principal_usd),
      ltvBps: Number(raw.ltv_bps),
      collateralLockedUsd: fromStroops(raw.collateral_locked),
      collateralReleasedUsd: fromStroops(raw.collateral_released),
      installmentCount: Number(raw.installment_count),
      intervalSecs: Number(raw.interval_secs),
      originatedAt: secs(raw.originated_at),
      installmentsPaid: Number(raw.installments_paid),
      totalRepaidUsd: fromStroops(raw.total_repaid_usd),
      nextDue: secs(raw.next_due),
      graceExpiresAt: Number(raw.grace_expires_at) > 0 ? secs(raw.grace_expires_at) : null,
      status: String(raw.status?.tag ?? raw.status).toLowerCase() as LoanStatus,
    };
  }

  /** The LTV, in basis points, the beneficiary's published reputation qualifies them for. */
  async requiredLtvBps(handle: string): Promise<number> {
    return Number(await this.read("ledger", "required_ltv_bps", { beneficiary: Buffer.from(handle, "hex") }));
  }

  // ─── Oracle ────────────────────────────────────────────────────────

  /** Publish a beneficiary's reputation score, 0–10,000 basis points. Returns the transaction hash. */
  async publishReputation(handle: string, scoreBps: number): Promise<string> {
    const oracle = this.need(this.opts.oracle, "an oracle key");
    const tx = await this.invoke("ledger", "set_reputation", {
      oracle: oracle.publicKey(),
      beneficiary: Buffer.from(handle, "hex"),
      score_bps: scoreBps,
    }, oracle);
    return (await this.send(tx, "ledger")).hash;
  }

  // ─── Guarantor-signed: prepare, then submit what the wallet signed ─────

  prepareDeposit(wallet: string, amountUsd: number): Promise<PreparedTx> {
    return this.prepare("vault", wallet, "deposit", { guarantor: wallet, amount: toStroops(amountUsd) });
  }

  prepareWithdraw(wallet: string, amountUsd: number): Promise<PreparedTx> {
    return this.prepare("vault", wallet, "withdraw", { guarantor: wallet, amount: toStroops(amountUsd) });
  }

  prepareOriginate(input: {
    wallet: string;
    beneficiaryHandle: string;
    partner: string;
    principalUsd: number;
    installmentCount: number;
    intervalSecs: number;
  }): Promise<PreparedTx> {
    return this.prepare("ledger", input.wallet, "originate", {
      guarantor: input.wallet,
      beneficiary: Buffer.from(input.beneficiaryHandle, "hex"),
      partner: input.partner,
      principal_usd: toStroops(input.principalUsd),
      installment_count: input.installmentCount,
      interval_secs: BigInt(input.intervalSecs),
    });
  }

  /**
   * Submit a transaction a wallet has signed, provided it is exactly the one
   * that was prepared. Returns its hash and the contract call's return value.
   */
  async submitSigned(prepared: Pick<PreparedTx, "hash">, signedXdr: string): Promise<{ hash: string; returnValue: unknown }> {
    const tx = assertSameTransaction(prepared.hash, signedXdr, this.opts.networkPassphrase);
    const server = new rpc.Server(this.opts.rpcUrl, { allowHttp: this.opts.rpcUrl.startsWith("http://") });

    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new ChainError(`The network rejected transaction ${sent.hash}`);
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await server.getTransaction(sent.hash);
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash: sent.hash, returnValue: res.returnValue ? scValToNative(res.returnValue) : undefined };
      }
      if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new ChainError(`Transaction ${sent.hash} failed on chain`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new ChainError(`Transaction ${sent.hash} was not confirmed in time`);
  }

  // ─── Verifier ──────────────────────────────────────────────────────

  /**
   * Record a repayment, co-signed by the loan's partner and the backend as
   * verifier. The partner signs its own authorization entry through
   * `signPartnerAuthEntry`; the backend signs the transaction and sends it.
   * Returns the collateral released.
   */
  async attestRepayment(input: {
    partner: string;
    loanId: bigint;
    amountUsd: number;
    signPartnerAuthEntry: SignAuthEntry;
  }): Promise<{ hash: string; releasedUsd: number }> {
    const verifier = this.need(this.opts.verifier, "a verifier key");
    const tx = await this.invoke("ledger", "attest_repayment", {
      partner: input.partner,
      verifier: verifier.publicKey(),
      loan_id: input.loanId,
      amount_usd: toStroops(input.amountUsd),
    }, verifier);

    const needed = await tx.needsNonInvokerSigningBy();
    if (needed.length !== 1 || needed[0] !== input.partner) {
      throw new ChainError(`Unexpected signers required: ${needed.join(", ") || "none"}`, "ledger");
    }
    await tx.signAuthEntries({ address: input.partner, signAuthEntry: input.signPartnerAuthEntry });

    const sent = await this.send(tx, "ledger");
    return { hash: sent.hash, releasedUsd: fromStroops(sent.result as bigint) };
  }

  // ─── Cranks (permissionless; the verifier pays the fee) ──────────────

  async flagOverdue(loanId: bigint): Promise<string> {
    const tx = await this.invoke("engine", "flag_overdue", { loan_id: loanId }, this.need(this.opts.verifier, "a verifier key"));
    return (await this.send(tx, "engine")).hash;
  }

  /** Liquidate a loan whose grace has expired. Returns the collateral forfeited. */
  async liquidate(loanId: bigint): Promise<{ hash: string; forfeitedUsd: number }> {
    const tx = await this.invoke("engine", "liquidate", { loan_id: loanId }, this.need(this.opts.verifier, "a verifier key"));
    const sent = await this.send(tx, "engine");
    return { hash: sent.hash, forfeitedUsd: fromStroops(sent.result as bigint) };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private need<T>(value: T | undefined, what: string): T {
    if (!value) throw new ChainError(`The chain client was configured without ${what}`);
    return value;
  }

  /** A contract client for `publicKey`, reusing the contract's interface once fetched. */
  private async client(name: ContractName, publicKey?: string, signer?: Keypair): Promise<contract.Client> {
    const contractId = this.opts.contracts[name];
    const base = {
      contractId,
      rpcUrl: this.opts.rpcUrl,
      networkPassphrase: this.opts.networkPassphrase,
      allowHttp: this.opts.rpcUrl.startsWith("http://"),
    };
    let spec = this.specs.get(contractId);
    if (!spec) {
      spec = (await contract.Client.from(base)).spec;
      this.specs.set(contractId, spec);
    }
    return new contract.Client(spec, {
      ...base,
      publicKey,
      ...(signer ? contract.basicNodeSigner(signer, this.opts.networkPassphrase) : {}),
    });
  }

  /** Build and simulate a call. A call the contract would refuse fails here, before signing. */
  private async invoke(name: ContractName, method: string, args: object, signer?: Keypair, publicKey?: string): Promise<Invocation> {
    const client = await this.client(name, publicKey ?? signer?.publicKey(), signer);
    let tx: Invocation;
    try {
      tx = await (client as unknown as Record<string, (a: object) => Promise<Invocation>>)[method](args);
    } catch (err) {
      throw chainErrorFrom(err, name, this.opts.contracts);
    }
    if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) {
      throw chainErrorFrom(tx.simulation.error, name, this.opts.contracts);
    }
    return tx;
  }

  private async read<T>(name: ContractName, method: string, args: object): Promise<T> {
    return (await this.invoke(name, method, args)).result as T;
  }

  private async prepare(name: ContractName, wallet: string, method: string, args: object): Promise<PreparedTx> {
    const tx = await this.invoke(name, method, args, undefined, wallet);
    // The wallet's signature on the envelope must be the only one needed.
    const others = await tx.needsNonInvokerSigningBy();
    if (others.length > 0) {
      throw new ChainError(`This transaction would also need signatures from ${others.join(", ")}`, name);
    }
    const built = tx.built!;
    return { xdr: built.toXDR(), hash: Buffer.from(built.hash()).toString("hex") };
  }

  private async send(tx: Invocation, name: ContractName): Promise<{ hash: string; result: unknown }> {
    try {
      const sent = await tx.signAndSend();
      return { hash: sent.sendTransactionResponse?.hash ?? "", result: sent.result };
    } catch (err) {
      throw chainErrorFrom(err, name, this.opts.contracts);
    }
  }
}
