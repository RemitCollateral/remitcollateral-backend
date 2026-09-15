import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { isStellarAddress, verifyWalletSignature } from "./signature";

// Produced by Keypair.signMessage in @stellar/stellar-sdk 17.1.0, the reference
// SEP-53 implementation that Freighter's signMessage follows. Seed: 32 bytes of 0x07.
const VECTOR = {
  wallet: "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
  message: "RemitCollateral test vector",
  signature: "WE30AZmRz78LnntBPShp/OqxdNmog4qEKUSdzNERd33UdIV5BnGgpWCAGLDOujFzcNwvFsASdKNl0/sROOf9Aw==",
};

test("accepts a SEP-53 signature from the reference implementation", () => {
  assert.equal(verifyWalletSignature(VECTOR.wallet, VECTOR.message, VECTOR.signature), true);
});

test("accepts the same signature hex-encoded", () => {
  const hex = Buffer.from(VECTOR.signature, "base64").toString("hex");
  assert.equal(verifyWalletSignature(VECTOR.wallet, VECTOR.message, hex), true);
});

test("rejects it over a different message", () => {
  assert.equal(verifyWalletSignature(VECTOR.wallet, `${VECTOR.message}!`, VECTOR.signature), false);
});

test("rejects it for a different wallet", () => {
  assert.equal(verifyWalletSignature(Keypair.random().publicKey(), VECTOR.message, VECTOR.signature), false);
});

test("accepts a raw signature over the message bytes, as Freighter's signBlob produces", () => {
  const key = Keypair.random();
  const message = "Sign in to RemitCollateral";
  const signature = Buffer.from(key.sign(Buffer.from(message, "utf8"))).toString("base64");
  assert.equal(verifyWalletSignature(key.publicKey(), message, signature), true);
});

test("treats malformed input as invalid rather than throwing", () => {
  assert.equal(verifyWalletSignature(VECTOR.wallet, VECTOR.message, ""), false);
  assert.equal(verifyWalletSignature(VECTOR.wallet, VECTOR.message, "not a signature"), false);
  assert.equal(verifyWalletSignature(VECTOR.wallet, VECTOR.message, VECTOR.signature.slice(0, 40)), false);
  assert.equal(verifyWalletSignature("GABC", VECTOR.message, VECTOR.signature), false);
});

test("recognises only Stellar account addresses", () => {
  assert.equal(isStellarAddress(VECTOR.wallet), true);
  assert.equal(isStellarAddress("CDCS5WKQPSQKA65HNDT6MS3OFS36VCZDMBJZ575REFDZCSABEUQFQSIL"), false); // a contract
  assert.equal(isStellarAddress(Keypair.random().secret()), false);
  assert.equal(isStellarAddress("not-an-address"), false);
});
