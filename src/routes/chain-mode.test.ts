/**
 * Guarantor vault actions with the contracts connected, against a fake chain
 * that behaves like the real client: prepared transactions, a signature
 * check on submission, and balances held on "chain" rather than locally.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../testing/server";
import { signIn } from "../testing/auth";
import { setChain, ChainPort } from "../chain/runtime";
import { ChainError } from "../chain/errors";
import { beneficiaries } from "../stores";
import { config } from "../config";

const balances = new Map<string, number>();
const prepared = new Map<string, { wallet: string; delta: number; xdr: string }>();
let counter = 0;

function prepare(wallet: string, delta: number) {
  counter += 1;
  const tx = { xdr: `xdr-${counter}`, hash: `hash-${counter}` };
  prepared.set(tx.hash, { wallet, delta, xdr: tx.xdr });
  return tx;
}

const fakeChain = {
  vaultPosition: async (wallet: string) => {
    const balanceUsd = balances.get(wallet) ?? 0;
    return { balanceUsd, lockedUsd: 0, availableUsd: balanceUsd };
  },
  prepareDeposit: async (wallet: string, usd: number) => prepare(wallet, usd),
  prepareWithdraw: async (wallet: string, usd: number) => {
    if (usd > (balances.get(wallet) ?? 0)) {
      throw new ChainError("Not enough unlocked collateral in the vault", "vault", 5, "InsufficientAvailable");
    }
    return prepare(wallet, -usd);
  },
  submitSigned: async (tx: { hash: string }, signedXdr: string) => {
    const entry = prepared.get(tx.hash);
    if (!entry || signedXdr !== `signed:${entry.xdr}`) {
      throw new ChainError("The signed transaction is not the one that was prepared");
    }
    balances.set(entry.wallet, (balances.get(entry.wallet) ?? 0) + entry.delta);
    prepared.delete(tx.hash);
    return { hash: tx.hash, returnValue: undefined };
  },
} as unknown as ChainPort;

let base = "";
let close: () => Promise<void>;
let token = "";
let wallet = "";

before(async () => {
  ({ base, close } = await startTestServer());
  const signedIn = await signIn(base);
  token = signedIn.token;
  wallet = signedIn.key.publicKey();
});
after(async () => {
  setChain(null);
  await close();
});

const call = async (method: string, path: string, body?: unknown, as = token) => {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

test("GET /chain reports whether the contracts are connected", async () => {
  setChain(null);
  assert.deepEqual((await call("GET", "/chain")).body, { enabled: false, network_passphrase: null });
  setChain(fakeChain);
  const on = (await call("GET", "/chain")).body;
  assert.equal(on.enabled, true);
  assert.equal(on.network_passphrase, config.chain.networkPassphrase);
});

test("with the contracts connected, collateral moves only with the wallet's signature", async () => {
  setChain(fakeChain);
  const direct = await call("POST", "/vaults/deposit", { amount_usd: 25 });
  assert.equal(direct.status, 409);
  assert.match(direct.body.message, /deposit\/prepare/);
});

test("a deposit is prepared, signed and submitted, and the vault reads from chain", async () => {
  setChain(fakeChain);
  const p = await call("POST", "/vaults/deposit/prepare", { amount_usd: 25 });
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.body).sort(), ["hash", "network_passphrase", "xdr"]);

  const s = await call("POST", "/vaults/deposit/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.collateral_balance, 25);
  assert.equal(balances.get(wallet), 25, "the balance lives on chain");

  assert.equal((await call("GET", "/vaults/me")).body.collateral_balance, 25);
  assert.equal((await call("GET", "/guarantors/me/dashboard")).body.vault.collateral_balance, 25);

  // Each prepared transaction is submitted once.
  const again = await call("POST", "/vaults/deposit/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
  assert.equal(again.status, 404);
});

test("a prepared transaction cannot be submitted by someone else, for another action, or altered", async () => {
  setChain(fakeChain);
  const p = await call("POST", "/vaults/deposit/prepare", { amount_usd: 5 });

  const other = await signIn(base);
  const stolen = await call("POST", "/vaults/deposit/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` }, other.token);
  assert.equal(stolen.status, 404, "another guarantor cannot submit it");

  const wrongKind = await call("POST", "/vaults/withdraw/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
  assert.equal(wrongKind.status, 404, "a deposit cannot be submitted as a withdrawal");

  const altered = await call("POST", "/vaults/deposit/submit", { hash: p.body.hash, signed_xdr: "signed:something-else" });
  assert.equal(altered.status, 400);
  assert.match(altered.body.message, /not the one that was prepared/);
});

test("a withdrawal the contract would refuse fails before the wallet is asked", async () => {
  setChain(fakeChain);
  const tooMuch = await call("POST", "/vaults/withdraw/prepare", { amount_usd: 1000 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.message, /unlocked collateral/);

  const p = await call("POST", "/vaults/withdraw/prepare", { amount_usd: 10 });
  const s = await call("POST", "/vaults/withdraw/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
  assert.equal(s.status, 200);
  assert.equal(s.body.collateral_balance, 15);
});

test("without the contracts, prepare and submit are refused", async () => {
  setChain(null);
  assert.equal((await call("POST", "/vaults/deposit/prepare", { amount_usd: 1 })).status, 409);
  assert.equal((await call("POST", "/vaults/withdraw/submit", { hash: "x", signed_xdr: "y" })).status, 409);
});

test("with a handle secret configured, a new beneficiary gets their on-chain handle", async () => {
  const saved = config.chain.beneficiaryHandleSecret;
  try {
    config.chain.beneficiaryHandleSecret = "test-handle-secret";
    const created = await call("POST", "/beneficiaries", {
      phone_number: "+2348000000777",
      local_kyc_ref: "PARTNER-NG-777",
      local_currency: "NGN",
    });
    assert.equal(created.status, 201);
    const record = beneficiaries.get(created.body.id)!;
    assert.match(record.chainHandle ?? "", /^[0-9a-f]{64}$/);
    assert.equal(created.body.chain_handle, undefined, "the handle is not part of the API");
  } finally {
    config.chain.beneficiaryHandleSecret = saved;
  }
});
