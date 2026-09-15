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
const locked = new Map<string, number>();
const reputations = new Map<string, number>(); // handle → score in basis points
const chainLoans = new Map<bigint, any>();
const published: Array<{ handle: string; scoreBps: number }> = [];
const prepared = new Map<string, { xdr: string; apply: () => unknown }>();
let counter = 0;

function prepare(apply: () => unknown) {
  counter += 1;
  const tx = { xdr: `xdr-${counter}`, hash: `hash-${counter}` };
  prepared.set(tx.hash, { xdr: tx.xdr, apply });
  return tx;
}
const ltvBpsFor = (handle: string) => 15_000 - Math.floor((4_000 * (reputations.get(handle) ?? 0)) / 10_000);
const deposit = (wallet: string, delta: number) => () => balances.set(wallet, (balances.get(wallet) ?? 0) + delta);

const fakeChain = {
  vaultPosition: async (wallet: string) => {
    const balanceUsd = balances.get(wallet) ?? 0;
    const lockedUsd = locked.get(wallet) ?? 0;
    return { balanceUsd, lockedUsd, availableUsd: balanceUsd - lockedUsd };
  },
  prepareDeposit: async (wallet: string, usd: number) => prepare(deposit(wallet, usd)),
  prepareWithdraw: async (wallet: string, usd: number) => {
    if (usd > (balances.get(wallet) ?? 0) - (locked.get(wallet) ?? 0)) {
      throw new ChainError("Not enough unlocked collateral in the vault", "vault", 5, "InsufficientAvailable");
    }
    return prepare(deposit(wallet, -usd));
  },
  requiredLtvBps: async (handle: string) => ltvBpsFor(handle),
  publishReputation: async (handle: string, scoreBps: number) => {
    reputations.set(handle, scoreBps);
    published.push({ handle, scoreBps });
    return "published";
  },
  prepareOriginate: async (input: any) =>
    prepare(() => {
      const ltvBps = ltvBpsFor(input.beneficiaryHandle);
      const collateral = Math.round(input.principalUsd * ltvBps) / 10_000;
      locked.set(input.wallet, (locked.get(input.wallet) ?? 0) + collateral);
      const id = BigInt(chainLoans.size + 1);
      chainLoans.set(id, {
        id, guarantor: input.wallet, beneficiaryHandle: input.beneficiaryHandle, partner: input.partner,
        principalUsd: input.principalUsd, ltvBps, collateralLockedUsd: collateral, collateralReleasedUsd: 0,
        installmentCount: input.installmentCount, intervalSecs: input.intervalSecs, originatedAt: new Date(),
        installmentsPaid: 0, totalRepaidUsd: 0, nextDue: new Date(), graceExpiresAt: null, status: "active",
      });
      return id;
    }),
  loan: async (id: bigint) => chainLoans.get(id) ?? null,
  submitSigned: async (tx: { hash: string }, signedXdr: string) => {
    const entry = prepared.get(tx.hash);
    if (!entry || signedXdr !== `signed:${entry.xdr}`) {
      throw new ChainError("The signed transaction is not the one that was prepared");
    }
    prepared.delete(tx.hash);
    return { hash: tx.hash, returnValue: entry.apply() };
  },
} as unknown as ChainPort;

let base = "";
let close: () => Promise<void>;
let token = "";
let wallet = "";

const savedPartner = config.chain.partnerAddress;

before(async () => {
  config.chain.partnerAddress = "GC26UMM7ICTUPT5DDJPQS6BM7Q4TJ2K7QCY4LMIQE5ETI7VDBJCPPE6R";
  ({ base, close } = await startTestServer());
  const signedIn = await signIn(base);
  token = signedIn.token;
  wallet = signedIn.key.publicKey();
});
after(async () => {
  config.chain.partnerAddress = savedPartner;
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

test("a loan is priced, signed in the wallet, and recorded against its on-chain ID", async () => {
  setChain(fakeChain);
  const saved = config.chain.beneficiaryHandleSecret;
  config.chain.beneficiaryHandleSecret = "test-handle-secret";
  try {
    const b = await call("POST", "/beneficiaries", {
      phone_number: "+2348000000888",
      local_kyc_ref: "PARTNER-NG-888",
      local_currency: "NGN",
      display_name: "Chidi",
    });
    assert.equal(b.status, 201);
    const funded = await call("POST", "/vaults/deposit/prepare", { amount_usd: 1000 });
    await call("POST", "/vaults/deposit/submit", { hash: funded.body.hash, signed_xdr: `signed:${funded.body.xdr}` });

    const request = {
      beneficiary_id: b.body.id,
      principal_local: 400000,
      local_currency: "NGN",
      installment_count: 4,
      installment_interval_days: 30,
    };
    const direct = await call("POST", "/loans", request);
    assert.equal(direct.status, 409);
    assert.match(direct.body.message, /loans\/prepare/);

    const p = await call("POST", "/loans/prepare", request);
    assert.equal(p.status, 200, JSON.stringify(p.body));

    // The chain now sets the same LTV the backend computed, so it locks the collateral that was quoted.
    const handle = beneficiaries.get(b.body.id)!.chainHandle!;
    const qualified = (await call("GET", `/beneficiaries/${b.body.id}/reputation`)).body.qualified_ltv;
    assert.equal(await fakeChain.requiredLtvBps(handle), Math.round(qualified * 10_000));

    const s = await call("POST", "/loans/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.principal_usd, 253.16, "priced at the partner's rate");
    assert.equal(s.body.schedule.length, 4);

    const onChain = chainLoans.get(1n);
    const view = (await call("GET", `/loans/${s.body.id}`)).body;
    // The chain carries USDC's sub-cent precision; the API reports to the cent.
    assert.equal(view.collateral_locked_usd, Math.round(onChain.collateralLockedUsd * 100) / 100, "collateral as locked on chain");
    assert.equal(view.ltv_ratio, onChain.ltvBps / 10_000);

    const again = await call("POST", "/loans/submit", { hash: p.body.hash, signed_xdr: `signed:${p.body.xdr}` });
    assert.equal(again.status, 404, "an origination is submitted once");
  } finally {
    config.chain.beneficiaryHandleSecret = saved;
  }
});

test("without a partner address configured, a loan cannot be prepared", async () => {
  setChain(fakeChain);
  const saved = config.chain.partnerAddress;
  try {
    config.chain.partnerAddress = "";
    const res = await call("POST", "/loans/prepare", {
      beneficiary_id: "any", principal_local: 1, local_currency: "NGN", installment_count: 1,
    });
    assert.equal(res.status, 503);
  } finally {
    config.chain.partnerAddress = saved;
  }
});
