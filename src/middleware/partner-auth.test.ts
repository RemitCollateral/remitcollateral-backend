import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "../testing/server";
import { config } from "../config";

let base = "";
let close: () => Promise<void>;
before(async () => ({ base, close } = await startTestServer()));
after(() => close());

const attest = (headers: Record<string, string>) =>
  fetch(`${base}/api/v1/repayments/attest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

test("partner endpoints need the configured key", async () => {
  const saved = config.partnerApiKey;
  try {
    config.partnerApiKey = "a-strong-partner-key";
    assert.equal((await attest({})).status, 401);
    assert.equal((await attest({ "x-api-key": "wrong" })).status, 403);
    assert.equal((await attest({ "x-api-key": "a-strong-partner-key-plus" })).status, 403);

    const authenticated = await attest({ "x-api-key": "a-strong-partner-key" });
    assert.ok(![401, 403, 503].includes(authenticated.status), `got ${authenticated.status}`);
  } finally {
    config.partnerApiKey = saved;
  }
});

test("with no key configured, partner endpoints refuse everyone, the old default key included", async () => {
  const saved = config.partnerApiKey;
  try {
    config.partnerApiKey = "";
    assert.equal((await attest({ "x-api-key": "dev-partner-key-v1" })).status, 503);
    assert.equal((await attest({})).status, 503);
  } finally {
    config.partnerApiKey = saved;
  }
});
