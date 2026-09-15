import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { beneficiaryHandle } from "./handle";
import { fromStroops, toStroops } from "./amounts";
import { chainErrorFrom } from "./errors";
import { assertSameTransaction } from "./soroban";

const IDS = {
  vault: "CD6TYOKK74XIACIS423QJ2XW3Z646AMMHEAPAIZR2SWKFTRA5F3FL3QR",
  ledger: "CDCS5WKQPSQKA65HNDT6MS3OFS36VCZDMBJZ575REFDZCSABEUQFQSIL",
  engine: "CC25FFHO6CFCBZPV5J7IJV4LJWDIN2X2LIELKBBBZBAYQV42CKXWC4NU",
};

test("beneficiary handles are keyed, deterministic, and 32 bytes", () => {
  const a = beneficiaryHandle("+2348031234567", "PARTNER-NG-1", "secret-one");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, beneficiaryHandle("+2348031234567", "PARTNER-NG-1", "secret-one"));
  assert.notEqual(a, beneficiaryHandle("+2348031234567", "PARTNER-NG-1", "secret-two"), "the secret matters");
  assert.notEqual(a, beneficiaryHandle("+2348031234568", "PARTNER-NG-1", "secret-one"));
  assert.notEqual(a, beneficiaryHandle("+2348031234567", "PARTNER-NG-2", "secret-one"));
  assert.throws(() => beneficiaryHandle("+2348031234567", "PARTNER-NG-1", ""), /required/);
});

test("USD amounts convert to and from USDC's 7 decimals", () => {
  assert.equal(toStroops(253.16), 2_531_600_000n);
  assert.equal(toStroops(0.01), 100_000n);
  assert.equal(fromStroops(12_350_000n), 1.235);
  assert.equal(fromStroops(toStroops(1400)), 1400);
  assert.throws(() => toStroops(Number.NaN));
});

test("a contract error is attributed to the contract that raised it", () => {
  // Originating on the ledger, but the vault refuses the lock.
  const detail = [
    "HostError: Error(Contract, #5)",
    "",
    "Event log (newest first):",
    `   0: [Diagnostic Event] contract:${IDS.ledger}, topics:[error, Error(Contract, #5)], data:"escalating"`,
    `   1: [Diagnostic Event] contract:${IDS.vault}, topics:[error, Error(Contract, #5)], data:["failing with contract error", 5]`,
  ].join("\n");
  const err = chainErrorFrom(detail, "ledger", IDS);
  assert.equal(err.contract, "vault");
  assert.equal(err.reason, "InsufficientAvailable");
  assert.match(err.message, /unlocked collateral/);
});

test("without diagnostic events, the invoked contract's code table is used", () => {
  const err = chainErrorFrom("HostError: Error(Contract, #10)", "ledger", IDS);
  assert.equal(err.reason, "LoanAlreadyOpen");
  assert.equal(chainErrorFrom("Error(Contract, #4)", "engine", IDS).reason, "NotOverdue");
});

test("a missing signature is reported as such", () => {
  const err = chainErrorFrom('failed account authentication with error {"auth":"invalid_action"}', "ledger", IDS);
  assert.equal(err.reason, "Auth");
  assert.match(err.message, /signature/);
});

function buildTx(source: Keypair, memoValue: string) {
  return new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "k", value: memoValue }))
    .setTimeout(300)
    .build();
}

test("only the exact transaction that was prepared is accepted once signed", () => {
  const wallet = Keypair.random();
  const prepared = buildTx(wallet, "v1");
  const expectedHash = Buffer.from(prepared.hash()).toString("hex");

  const signed = buildTx(wallet, "v1");
  signed.sign(wallet);
  assert.equal(assertSameTransaction(expectedHash, signed.toXDR(), Networks.TESTNET).signatures.length, 1);

  const other = buildTx(wallet, "v2");
  other.sign(wallet);
  assert.throws(() => assertSameTransaction(expectedHash, other.toXDR(), Networks.TESTNET), /not the one that was prepared/);

  const unsigned = buildTx(wallet, "v1");
  assert.throws(() => assertSameTransaction(expectedHash, unsigned.toXDR(), Networks.TESTNET), /not been signed/);
  assert.throws(() => assertSameTransaction(expectedHash, "garbage", Networks.TESTNET), /not a valid/);
});
