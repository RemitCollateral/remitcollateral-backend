import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./testing/server";

let base = "";
let close: () => Promise<void>;

before(async () => ({ base, close } = await startTestServer()));
after(() => close());

test("the app serves requests without starting the real server", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test("unknown endpoints return 404", async () => {
  const res = await fetch(`${base}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);
});
