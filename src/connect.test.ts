import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent, savedCredential } from './credentials.js';
import {ensureCredentialDirectory} from './storage.js';
import {assertPrivate,grantOtherUser} from './platform-test-helpers.js';

const code = 'uks_' + 'c'.repeat(43);
const token = 'uk_' + 'a'.repeat(12) + '.' + 'b'.repeat(32);
const result = { data: { token, key: { id: 'agent-id', kind: 'AGENT', scopes: ['read', 'rent', 'manage'] } } };
async function isolated(run: (home: string) => Promise<void>) {
  const oldHome = process.env.HOME, oldProfile=process.env.USERPROFILE, oldToken = process.env.UKIYO_API_TOKEN;
  const home = mkdtempSync(join(tmpdir(), 'ukiyo-connect-unit-')); process.env.HOME = home; process.env.USERPROFILE=home; delete process.env.UKIYO_API_TOKEN;
  try { await run(home); } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=oldProfile;
    if (oldToken === undefined) delete process.env.UKIYO_API_TOKEN; else process.env.UKIYO_API_TOKEN = oldToken;
  }
}
test('connect exchanges without Authorization, stores private agent token, returns no secret and pins API origin', async () => isolated(async home => {
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, 'https://pay.u-kiyo.ai/api/v1/agent-setups/exchange');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(init.redirect, 'error'); assert.deepEqual(JSON.parse(String(init.body)), { setupCode: code });
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const response = await connectAgent(code, undefined, fetcher);
  assert.ok(!JSON.stringify(response).includes(token));
  const path = join(home, '.ukiyo/credentials.json');
  assertPrivate(path); assertPrivate(join(home, '.ukiyo'),true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, token);
  assert.equal(savedCredential('https://pay.u-kiyo.ai'), token);
  assert.throws(() => savedCredential('https://different.example'), /different API origin/);
  await assert.rejects(connectAgent(code, undefined, fetcher), /EEXIST/); assert.equal(calls, 1);
  if(process.platform==='win32')grantOtherUser(path);else chmodSync(path, 0o644);
  assert.throws(() => savedCredential('https://pay.u-kiyo.ai'), /private|access controls/);
}));
test('connect rejects unsafe origin and owner-token environment before exchange', async () => isolated(async () => {
  const fetcher = (async () => { throw new Error('must not call'); }) as typeof fetch;
  for (const origin of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/path']) await assert.rejects(connectAgent(code, origin, fetcher), /HTTPS API origin/);
  process.env.UKIYO_API_TOKEN = 'owner-secret';
  await assert.rejects(connectAgent(code, undefined, fetcher), /Unset UKIYO_API_TOKEN/);
}));
test('connect refuses directory/file symlinks and insecure directory without consuming code', async () => isolated(async home => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ukiyo-connect-target-'));
  symlinkSync(elsewhere, join(home, '.ukiyo'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(connectAgent(code), /not a symlink/);
}));
test('connect refuses an existing secret path without modifying its target', async () => isolated(async home => {
  ensureCredentialDirectory();
  const target = join(home, 'owner-secret'); writeFileSync(target, 'unchanged'); symlinkSync(target, join(home, '.ukiyo/credentials.json'));
  await assert.rejects(connectAgent(code), /EEXIST/); assert.equal(readFileSync(target, 'utf8'), 'unchanged');
}));
test('failed or malformed exchange does not leave a credential, retry, or accept owner/billing scopes', async () => isolated(async home => {
  for (const response of [new Response(JSON.stringify({ error: { code: 'AGENT_SETUP_INVALID', message: 'Already used.' } }), { status: 409 }), new Response(JSON.stringify({ data: { token, key: { kind: 'OWNER', scopes: ['read', 'rent', 'manage', 'billing'] } } }))]) {
    let calls = 0;
    await assert.rejects(connectAgent(code, undefined, (async () => { calls++; return response; }) as typeof fetch), (error: any) =>
      response.status === 409 ? error.code === 'AGENT_SETUP_INVALID' && error.status === 409 && error.message === 'Already used.' : /owner|scoped agent/.test(error.message));
    assert.equal(calls, 1); assert.equal(existsSync(join(home, '.ukiyo/credentials.json')), false);
  }
}));
