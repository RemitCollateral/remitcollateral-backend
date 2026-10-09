import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../testing/server";
import { config } from "../config";
import app from "../app";

let base = "";
let close: () => Promise<void>;
before(async () => ({ base, close } = await startTestServer()));
after(() => close());

test("GET /auth/challenge is rate limited once a client exceeds the configured max", async () => {
  const max = config.rateLimits.authChallengeMax;
  const statuses: number[] = [];
  for (let i = 0; i < max + 1; i++) {
    const res = await fetch(`${base}/api/v1/auth/challenge?wallet_address=GINVALIDWALLETADDRESSVALUEHERE`);
    statuses.push(res.status);
  }

  assert.ok(
    statuses.slice(0, max).every((status) => status !== 429),
    `no request within the configured limit should be throttled, got: ${statuses.slice(0, max)}`,
  );
  assert.equal(statuses[max], 429, "the request past the limit should be throttled");
});

test("POST /repayments/attest is rate limited per presented API key, not globally", async () => {
  const max = config.rateLimits.repaymentAttestMax;
  const attest = (apiKey: string) =>
    fetch(`${base}/api/v1/repayments/attest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: "{}",
    });

  const statuses: number[] = [];
  for (let i = 0; i < max + 1; i++) {
    statuses.push((await attest("rate-limit-test-key-a")).status);
  }
  assert.ok(
    statuses.slice(0, max).every((status) => status !== 429),
    `no request within the configured limit should be throttled, got: ${statuses.slice(0, max)}`,
  );
  assert.equal(statuses[max], 429, "the request past the limit should be throttled");

  // A different key has its own budget, untouched by the one above.
  const otherKeyStatus = (await attest("rate-limit-test-key-b")).status;
  assert.notEqual(otherKeyStatus, 429);
});

test("behind a trusted proxy each client gets its own rate-limit budget", async () => {
  const max = config.rateLimits.authChallengeMax;
  const challenge = (clientIp: string) =>
    fetch(`${base}/api/v1/auth/challenge?wallet_address=GINVALIDWALLETADDRESSVALUEHERE`, {
      headers: { "x-forwarded-for": clientIp },
    });

  app.set("trust proxy", 1);
  try {
    const first: number[] = [];
    for (let i = 0; i < max + 1; i++) first.push((await challenge("203.0.113.10")).status);
    assert.equal(first[max], 429, "the first client runs out of budget");

    // A different client behind the same proxy is unaffected.
    assert.notEqual((await challenge("203.0.113.11")).status, 429);
  } finally {
    app.set("trust proxy", false);
  }
});
