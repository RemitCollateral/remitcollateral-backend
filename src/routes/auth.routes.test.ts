import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { startTestServer } from "../testing/server";
import { authChallenges, sessions } from "../stores";
import { config } from "../config";

let base = "";
let close: () => Promise<void>;
before(async () => ({ base, close } = await startTestServer()));
after(() => close());

const api = (path: string, init?: RequestInit) => fetch(`${base}/api/v1${path}`, init);
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const sign = (key: Keypair, message: string) => Buffer.from(key.signMessage(message)).toString("base64");

type Challenge = { wallet_address: string; challenge: string; expires_at: string };
type SignedIn = { token: string; guarantor: Record<string, unknown>; expires_at: string };

async function challengeFor(wallet: string): Promise<Challenge> {
  const res = await api(`/auth/challenge?wallet_address=${wallet}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Challenge;
}

async function signIn(key = Keypair.random()): Promise<SignedIn & { key: Keypair }> {
  const { challenge } = await challengeFor(key.publicKey());
  const res = await api("/auth/verify", post({ wallet_address: key.publicKey(), signature: sign(key, challenge) }));
  assert.equal(res.status, 200);
  return { key, ...((await res.json()) as SignedIn) };
}

test("a challenge is issued only for a valid Stellar account address", async () => {
  assert.equal((await api("/auth/challenge")).status, 400);
  assert.equal((await api("/auth/challenge?wallet_address=not-an-address")).status, 400);

  const key = Keypair.random();
  const c = await challengeFor(key.publicKey());
  assert.equal(c.wallet_address, key.publicKey());
  assert.ok(c.challenge.includes(`Wallet: ${key.publicKey()}`));
  assert.ok(c.challenge.startsWith(`Sign in to ${config.authDomain}`));
  assert.ok(Date.parse(c.expires_at) > Date.now());
});

test("signing in returns a session in the shape the frontend expects", async () => {
  const { key, token, guarantor, expires_at } = await signIn();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(guarantor).sort(), ["created_at", "display_name", "id", "wallet_address"]);
  assert.equal(guarantor.wallet_address, key.publicKey());
  assert.ok(Date.parse(expires_at) > Date.now());

  // The first sign-in registers the wallet, so the session reaches guarantor routes.
  assert.equal((await api("/guarantors/me", bearer(token))).status, 200);
});

test("a signature cannot be replayed", async () => {
  const key = Keypair.random();
  const { challenge } = await challengeFor(key.publicKey());
  const body = post({ wallet_address: key.publicKey(), signature: sign(key, challenge) });
  assert.equal((await api("/auth/verify", body)).status, 200);
  assert.equal((await api("/auth/verify", body)).status, 401);
});

test("a signature by another key, or over another message, is refused", async () => {
  const key = Keypair.random();
  const { challenge } = await challengeFor(key.publicKey());

  const byImpostor = post({ wallet_address: key.publicKey(), signature: sign(Keypair.random(), challenge) });
  assert.equal((await api("/auth/verify", byImpostor)).status, 401);
  const overOtherMessage = post({ wallet_address: key.publicKey(), signature: sign(key, "Sign in") });
  assert.equal((await api("/auth/verify", overOtherMessage)).status, 401);

  // Failed attempts do not burn the challenge: the genuine signature still works.
  const genuine = post({ wallet_address: key.publicKey(), signature: sign(key, challenge) });
  assert.equal((await api("/auth/verify", genuine)).status, 200);
});

test("asking for a new challenge does not cancel an outstanding one", async () => {
  const key = Keypair.random();
  const first = await challengeFor(key.publicKey());
  await challengeFor(key.publicKey()); // as if requested by someone else for this wallet
  const res = await api("/auth/verify", post({ wallet_address: key.publicKey(), signature: sign(key, first.challenge) }));
  assert.equal(res.status, 200);
});

test("an expired challenge is refused", async () => {
  const key = Keypair.random();
  const { challenge } = await challengeFor(key.publicKey());
  for (const c of authChallenges.get(key.publicKey()) ?? []) {
    c.expiresAt = new Date(Date.now() - 1000).toISOString();
  }
  const res = await api("/auth/verify", post({ wallet_address: key.publicKey(), signature: sign(key, challenge) }));
  assert.equal(res.status, 401);
});

test("protected routes need a session, and a wallet header alone grants nothing", async () => {
  const { key } = await signIn();
  // This header used to be trusted on its own.
  assert.equal((await api("/guarantors/me", { headers: { "x-wallet-address": key.publicKey() } })).status, 401);
  assert.equal((await api("/guarantors/me")).status, 401);
  assert.equal((await api("/guarantors/me", bearer("0".repeat(64)))).status, 401);
  assert.equal((await api("/guarantors/me", { headers: { authorization: "Bearer not-a-token" } })).status, 401);
});

test("an expired session is refused", async () => {
  const { token } = await signIn();
  for (const session of sessions.values()) {
    session.expiresAt = new Date(Date.now() - 1000).toISOString();
  }
  assert.equal((await api("/guarantors/me", bearer(token))).status, 401);
});

test("admin routes fail closed", async () => {
  const saved = config.adminWalletAddress;
  try {
    const { key, token } = await signIn();

    config.adminWalletAddress = "";
    assert.equal((await api("/audit", bearer(token))).status, 403, "with no admin configured, nobody is admin");

    config.adminWalletAddress = Keypair.random().publicKey();
    assert.equal((await api("/audit", bearer(token))).status, 403);

    config.adminWalletAddress = key.publicKey();
    assert.equal((await api("/audit", bearer(token))).status, 200);
    assert.equal((await api("/audit", { headers: { "x-wallet-address": key.publicKey() } })).status, 401);
  } finally {
    config.adminWalletAddress = saved;
  }
});
