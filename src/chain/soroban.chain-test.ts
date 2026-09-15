/**
 * The chain client against a real deployment. Run with `npm run test:chain`.
 *
 * Needs GUARANTOR_VAULT_CONTRACT_ID, LOAN_LEDGER_CONTRACT_ID,
 * LIQUIDATION_ENGINE_CONTRACT_ID, VERIFIER_SECRET_KEY, ORACLE_SECRET_KEY, and
 * funded testnet accounts in CHAIN_TEST_GUARANTOR_SECRET (holding the vault's
 * USDC) and CHAIN_TEST_PARTNER_SECRET (a registered partner). The guarantor
 * signs with its key here, standing in for a wallet such as Freighter.
 */
import dns from "node:dns";
import net from "node:net";
import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, TransactionBuilder, contract } from "@stellar/stellar-sdk";
import { chainFromConfig, ChainError, PreparedTx } from "./index";
import { config } from "../config";

// Some hosts advertise IPv6 without routing it; keep RPC calls on IPv4.
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);

const guarantorSecret = process.env.CHAIN_TEST_GUARANTOR_SECRET;
const partnerSecret = process.env.CHAIN_TEST_PARTNER_SECRET;
const chain = chainFromConfig();
const ready = Boolean(chain && guarantorSecret && partnerSecret && config.chain.verifierSecretKey && config.chain.oracleSecretKey);

test("the chain client drives the contracts end to end", { skip: !ready && "chain test environment not set" }, async (t) => {
  const c = chain!;
  const guarantor = Keypair.fromSecret(guarantorSecret!);
  const partner = Keypair.fromSecret(partnerSecret!);
  const wallet = guarantor.publicKey();
  const passphrase = config.chain.networkPassphrase;

  // Stand-in for the wallet: sign the envelope the backend prepared.
  const sign = (prepared: PreparedTx) => {
    const tx = TransactionBuilder.fromXDR(prepared.xdr, passphrase);
    tx.sign(guarantor);
    return tx.toXDR();
  };
  // A fresh beneficiary per run, so reruns never collide.
  const handle = crypto.randomBytes(32).toString("hex");

  const start = await c.vaultPosition(wallet);

  await t.test("a deposit is prepared, signed by the wallet, and submitted", async () => {
    const prepared = await c.prepareDeposit(wallet, 10);
    await c.submitSigned(prepared, sign(prepared));
    const after = await c.vaultPosition(wallet);
    assert.equal(after.balanceUsd, start.balanceUsd + 10);
  });

  await t.test("a signed transaction other than the one prepared is refused", async () => {
    const prepared = await c.prepareDeposit(wallet, 1);
    const other = await c.prepareDeposit(wallet, 2);
    await assert.rejects(c.submitSigned(prepared, sign(other)), /not the one that was prepared/);
  });

  await t.test("the oracle publishes a reputation score that sets the LTV", async () => {
    assert.equal(await c.requiredLtvBps(handle), 15_000);
    await c.publishReputation(handle, 5_000);
    assert.equal(await c.requiredLtvBps(handle), 13_000);
  });

  let loanId = 0n;
  await t.test("a loan is originated by the guarantor's signature", async () => {
    const prepared = await c.prepareOriginate({
      wallet,
      beneficiaryHandle: handle,
      partner: partner.publicKey(),
      principalUsd: 2,
      installmentCount: 2,
      intervalSecs: 3600,
    });
    loanId = BigInt((await c.submitSigned(prepared, sign(prepared))).returnValue as bigint);
    const loan = (await c.loan(loanId))!;
    assert.equal(loan.status, "active");
    assert.equal(loan.beneficiaryHandle, handle);
    assert.equal(loan.principalUsd, 2);
    assert.equal(loan.collateralLockedUsd, 2.6); // 2 USD at 130% LTV
  });

  await t.test("the same pair cannot open a second loan", async () => {
    await assert.rejects(
      c.prepareOriginate({ wallet, beneficiaryHandle: handle, partner: partner.publicKey(), principalUsd: 1, installmentCount: 1, intervalSecs: 3600 }),
      (err: unknown) => err instanceof ChainError && err.reason === "LoanAlreadyOpen",
    );
  });

  await t.test("repayments are co-signed by the partner and the verifier", async () => {
    const partnerSigner = contract.basicNodeSigner(partner, passphrase).signAuthEntry;
    const first = await c.attestRepayment({ partner: partner.publicKey(), loanId, amountUsd: 1, signPartnerAuthEntry: partnerSigner });
    assert.equal(first.releasedUsd, 1.235); // 2.6 × 50% × 95%

    await c.attestRepayment({ partner: partner.publicKey(), loanId, amountUsd: 1, signPartnerAuthEntry: partnerSigner });
    const loan = (await c.loan(loanId))!;
    assert.equal(loan.status, "repaid");
    assert.equal(loan.collateralReleasedUsd, 2.6);
  });

  await t.test("a crank on a loan that is not overdue is refused with a readable reason", async () => {
    await assert.rejects(c.flagOverdue(loanId), (err: unknown) => err instanceof ChainError && err.reason === "NotOverdue");
  });

  await t.test("withdrawing more than is free is refused before signing", async () => {
    const free = (await c.vaultPosition(wallet)).availableUsd;
    await assert.rejects(
      c.prepareWithdraw(wallet, free + 1),
      (err: unknown) => err instanceof ChainError && err.reason === "InsufficientAvailable",
    );
  });

  await t.test("the deposit is withdrawn back through the wallet", async () => {
    const prepared = await c.prepareWithdraw(wallet, 10);
    await c.submitSigned(prepared, sign(prepared));
    assert.equal((await c.vaultPosition(wallet)).balanceUsd, start.balanceUsd);
  });
});
