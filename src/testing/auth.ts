import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

/** Sign in as a (by default fresh) wallet, returning its session token. */
export async function signIn(base: string, key = Keypair.random()): Promise<{ key: Keypair; token: string }> {
  const challengeRes = await fetch(`${base}/api/v1/auth/challenge?wallet_address=${key.publicKey()}`);
  assert.equal(challengeRes.status, 200);
  const { challenge } = (await challengeRes.json()) as { challenge: string };

  const verifyRes = await fetch(`${base}/api/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet_address: key.publicKey(),
      signature: Buffer.from(key.signMessage(challenge)).toString("base64"),
    }),
  });
  assert.equal(verifyRes.status, 200);
  const { token } = (await verifyRes.json()) as { token: string };
  return { key, token };
}
