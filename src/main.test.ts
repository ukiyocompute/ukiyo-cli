import assert from "node:assert/strict";
import { test } from "node:test";
import { UkiyoClient } from "./client.js";
import { buildProgram } from "./main.js";

function harness(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const lines: string[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new UkiyoClient({ baseUrl: "https://pay.u-kiyo.ai", token: "uk_test.secret", fetcher });
  const program = buildProgram({ client, out: line => lines.push(line) });
  const run = (args: string[]) => program.parseAsync(["node", "ukiyo", ...args]);
  return { run, lines, calls, output: () => lines.join("\n") };
}

test("auth leads with headless signup and keeps owner credentials out of the agent", async () => {
  const h = harness(() => ({ body: {} }));
  await h.run(["auth"]);
  assert.match(h.output(), /ukiyo signup --json/);
  assert.match(h.output(), /ukiyo connect/);
  assert.match(h.output(), /Do not copy an owner token/);
  assert.match(h.output(), /scoped agent token/);
  assert.match(h.output(), /https:\/\/u-kiyo.ai\/terms\//);
  assert.match(h.output(), /--accept-terms <current-version>/);
  assert.equal(h.calls.length, 0);
});

test("offers prints the catalogue", async () => {
  const h = harness(() => ({ body: { data: [{ id: "offer-1", name: "NVIDIA RTX 4090", pricePerHourMinor: 66 }] } }));
  await h.run(["offers"]);
  assert.deepEqual(JSON.parse(h.output()), [{ id: "offer-1", name: "NVIDIA RTX 4090", pricePerHourMinor: 66 }]);
});

test("list and status hit the right endpoints", async () => {
  const h = harness(() => ({ body: { data: [] } }));
  await h.run(["list"]);
  await h.run(["status", "dep-1"]);
  assert.ok(h.calls[0]!.url.endsWith("/api/v1/deployments"));
  assert.ok(h.calls[1]!.url.endsWith("/api/v1/deployments/dep-1"));
});

test("credentials shows connection metadata but never prints access secrets", async () => {
  const h = harness(() => ({ body: { data: { sshHost: "ssh.example", sshPort: 2222, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" } } }));
  await h.run(["credentials", "dep-1"]);
  assert.equal(h.calls[0]!.init.method, "POST");
  assert.match(h.output(), /ssh\.example/);
  assert.doesNotMatch(h.output(), /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(JSON.parse(h.output()).privateKey, '[REDACTED]');
});

test("deploy converts dollars to minor units and sends a fresh idempotency key", async () => {
  const h = harness(() => ({ body: { data: { id: "order-1" } } }));
  await h.run(["deploy", "--offer", "offer-1", "--budget", "19.99"]);
  assert.deepEqual(JSON.parse(String(h.calls[0]!.init.body)), { offerId: "offer-1", budgetMinor: 1999 });
  const key = (h.calls[0]!.init.headers as any)["idempotency-key"];
  assert.match(key, /^[0-9a-f-]{36}$/);
});

test("deploy rejects a bad budget without contacting the API", async () => {
  const h = harness(() => ({ body: {} }));
  await assert.rejects(() => h.run(["deploy", "--offer", "o", "--budget", "twenty"]), (error: any) => error.code === "INVALID_BUDGET");
  assert.equal(h.calls.length, 0);
});

test("terminate refuses to run without explicit confirmation", async () => {
  const h = harness(() => ({ body: { data: { accepted: true } } }));
  await assert.rejects(() => h.run(["terminate", "dep-1"]), (error: any) => {
    assert.equal(error.code, "CONFIRMATION_REQUIRED");
    assert.match(error.message, /irreversible/);
    return true;
  });
  assert.equal(h.calls.length, 0, "an unconfirmed terminate must not reach the API");
});

test("terminate --yes proceeds and sends the documented reason", async () => {
  const h = harness(() => ({ body: { data: { accepted: true } } }));
  await h.run(["terminate", "dep-1", "--yes"]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(String(h.calls[0]!.init.body)), { reason: "USER_REQUESTED" });
});

test("every documented command is registered", async () => {
  const program = buildProgram({ out: () => {} });
  const names = program.commands.map(command => command.name()).sort();
  assert.deepEqual(names, ["auth", "balance", "connect", "credentials", "deploy", "exec", "list", "me", "offers", "rent", "rental", "signup", "status", "terminate", "topup"]);
});
