import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, dollarsToMinor, UkiyoClient } from "./client.js";

function stub(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("dollars convert to minor units without floating-point drift", () => {
  assert.equal(dollarsToMinor("20"), 2000);
  assert.equal(dollarsToMinor("19.99"), 1999);
  assert.equal(dollarsToMinor("0.07"), 7);
  assert.equal(dollarsToMinor("1.1"), 110);
  assert.equal(dollarsToMinor(" 5 "), 500);
  // 10.55 * 100 is 1054.9999... in binary floating point.
  assert.equal(dollarsToMinor("10.55"), 1055);
  assert.equal(dollarsToMinor("1.005".slice(0, 4)), 100);
});

test("a malformed budget is rejected before any request is sent", () => {
  for (const bad of ["", "abc", "-5", "1.234", "1e3", "$20", "20."]) {
    assert.throws(() => dollarsToMinor(bad), (error: any) => error.code === "INVALID_BUDGET", `expected "${bad}" to be rejected`);
  }
});

test("authenticated calls attach the bearer token", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: [] } }));
  await new UkiyoClient({ token: "uk_abc.secret", fetcher }).deployments();
  assert.equal((calls[0]!.init.headers as any).authorization, "Bearer uk_abc.secret");
});

test("listing offers needs no token", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: [{ id: "offer" }] } }));
  const offers = await new UkiyoClient({ fetcher }).offers();
  assert.deepEqual(offers, [{ id: "offer" }]);
  assert.equal((calls[0]!.init.headers as any).authorization, undefined);
});

test("an authenticated call without a token fails locally with instructions", async () => {
  const { fetcher, calls } = stub(() => ({ body: {} }));
  await assert.rejects(() => new UkiyoClient({ fetcher }).deployments(), (error: any) => {
    assert.equal(error.code, "UNAUTHENTICATED");
    assert.match(error.message, /ukiyo signup --json/);
    return true;
  });
  assert.equal(calls.length, 0, "no request should leave the machine without a token");
});

test("the data envelope is unwrapped", async () => {
  const { fetcher } = stub(() => ({ body: { data: { id: "d1", status: "ACTIVE" }, meta: { apiVersion: "v1" } } }));
  assert.deepEqual(await new UkiyoClient({ token: "t", fetcher }).deployment("d1"), { id: "d1", status: "ACTIVE" });
});

test("a 401 is translated into an actionable message", async () => {
  const { fetcher } = stub(() => ({ status: 401, body: {} }));
  await assert.rejects(() => new UkiyoClient({ token: "stale", fetcher }).deployments(), (error: ApiError) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /do not create a new account/);
    return true;
  });
});

test("a domain error code from the API is preserved", async () => {
  const { fetcher } = stub(() => ({ status: 404, body: { error: { code: "DEPLOYMENT_NOT_FOUND", message: "Deployment not found" } } }));
  await assert.rejects(() => new UkiyoClient({ token: "t", fetcher }).deployment("nope"), (error: ApiError) => {
    assert.equal(error.code, "DEPLOYMENT_NOT_FOUND");
    return true;
  });
});

test("ids are URL-encoded so a crafted id cannot alter the path", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: {} } }));
  await new UkiyoClient({ token: "t", fetcher }).deployment("../../admin/users");
  assert.ok(calls[0]!.url.endsWith("/api/v1/deployments/..%2F..%2Fadmin%2Fusers"), calls[0]!.url);
});

test("checkout sends minor units and an idempotency key", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: { id: "order" } } }));
  await new UkiyoClient({ token: "t", fetcher }).checkout("offer-1", 2000, "key-123");
  assert.equal((calls[0]!.init.headers as any)["idempotency-key"], "key-123");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { offerId: "offer-1", budgetMinor: 2000 });
});

test("credentials reveal is a POST, matching the audited endpoint", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: { sshHost: "h", sshPort: 2222, privateKey: "-----BEGIN..." } } }));
  const creds: any = await new UkiyoClient({ token: "t", fetcher }).credentials("d1");
  assert.equal(calls[0]!.init.method, "POST");
  assert.ok(calls[0]!.url.endsWith("/deployments/d1/credentials/reveal"));
  assert.equal(creds.sshPort, 2222);
});

test("a trailing slash on the base URL does not double up", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: [] } }));
  await new UkiyoClient({ baseUrl: "https://pay.u-kiyo.ai///", fetcher }).offers();
  assert.equal(calls[0]!.url, "https://pay.u-kiyo.ai/api/v1/offers");
});

test("a bodyless POST does not claim a JSON body", async () => {
  // Fastify returns 500 for `content-type: application/json` with an empty body,
  // which is exactly what credentials/reveal is.
  const { fetcher, calls } = stub(() => ({ body: { data: {} } }));
  await new UkiyoClient({ token: "t", fetcher }).credentials("dep-1");
  assert.equal((calls[0]!.init.headers as any)["content-type"], undefined);
});

test("a POST with a body still declares JSON", async () => {
  const { fetcher, calls } = stub(() => ({ body: { data: {} } }));
  await new UkiyoClient({ token: "t", fetcher }).terminate("dep-1");
  assert.equal((calls[0]!.init.headers as any)["content-type"], "application/json");
});
