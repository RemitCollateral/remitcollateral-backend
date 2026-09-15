import { test } from "node:test";
import assert from "node:assert/strict";
import { INDICATIVE_RATES, MockOffRampAdapter } from "./mock-offramp.adapter";

test("the mock partner quotes its indicative rates", async () => {
  const adapter = new MockOffRampAdapter();
  for (const [currency, rate] of Object.entries(INDICATIVE_RATES)) {
    const quote = await adapter.getExchangeRate(currency);
    assert.equal(quote.local_currency, currency);
    assert.equal(quote.local_per_usd, rate);
    assert.ok(!Number.isNaN(Date.parse(quote.quoted_at)));
  }
});

test("it refuses a currency it cannot pay out in", async () => {
  await assert.rejects(new MockOffRampAdapter().getExchangeRate("ZZZ"), /does not pay out in ZZZ/);
});
