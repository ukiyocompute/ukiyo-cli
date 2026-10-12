import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signupAgent, savedCredential, connectExistingAccount } from './credentials.js';
import { executeSsh } from './ssh.js';
import type { execFile } from 'node:child_process';
import {ensureCredentialDirectory} from './storage.js';
import {assertPrivate} from './platform-test-helpers.js';

const token = 'uk_' + 'a'.repeat(12) + '.' + 'b'.repeat(32);
const limits = { maxPerRentalMinor: 500, budgetLimitMinor: 50000, maxConcurrentDeployments: 1 };
const data = { token, account: { id: 'account-id', email: null, balanceMinor: 0 }, key: { id: 'key-id', kind: 'AGENT', scopes: ['read', 'rent', 'manage', 'billing'], ...limits } };
async function isolated(run: (home: string) => Promise<void>) {
  const oldHome = process.env.HOME, oldProfile=process.env.USERPROFILE, oldToken = process.env.UKIYO_API_TOKEN;
  const home = mkdtempSync(join(tmpdir(), 'ukiyo-signup-unit-')); process.env.HOME = home; process.env.USERPROFILE=home; delete process.env.UKIYO_API_TOKEN;
  try { await run(home); } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=oldProfile;
    if (oldToken === undefined) delete process.env.UKIYO_API_TOKEN; else process.env.UKIYO_API_TOKEN = oldToken;
  }
}
test('signup needs no identity, persists only scoped credential, verifies /me and prints no secret', async () => isolated(async home => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (url.endsWith('/signup')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.deepEqual(JSON.parse(String(init.body)), limits);
      assert.match(new Headers(init.headers).get('idempotency-key')!, /^[a-f0-9-]{36}$/);
      return new Response(JSON.stringify({ data }));
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(savedCredential('https://pay.u-kiyo.ai'), token, 'persist before verifying');
    return new Response(JSON.stringify({ data: { user: { id: data.account.id }, key: data.key } }));
  }) as typeof fetch;
  const result = await signupAgent(limits, undefined, fetcher);
  assert.ok(!JSON.stringify(result).includes(token)); assert.equal(calls.length, 2);
  assertPrivate(join(home, '.ukiyo/credentials.json'));
  assertPrivate(join(home, '.ukiyo'),true);
  await assert.rejects(signupAgent(limits, undefined, fetcher), /EEXIST/); assert.equal(calls.length, 2);
}));
test('signup verification failure preserves the only saved credential, rejects owner credential responses', async () => isolated(async home => {
  await assert.rejects(signupAgent(limits, undefined, (async () => new Response(JSON.stringify({ data: { ...data, key: { ...data.key, kind: 'OWNER' } } }))) as typeof fetch), /Unexpected signup/);
  assert.equal(existsSync(join(home, '.ukiyo/credentials.json')), false);
  let count = 0;
  await assert.rejects(signupAgent(limits, undefined, (async () => ++count === 1 ? new Response(JSON.stringify({ data })) : new Response('', { status: 503 })) as typeof fetch), /Credential saved/);
  assert.equal(savedCredential('https://pay.u-kiyo.ai'), token); assert.equal(count, 2);
}));
test('signup refuses owner-token environment without contacting the API', async () => isolated(async () => {
  process.env.UKIYO_API_TOKEN = 'owner-secret';
  await assert.rejects(signupAgent(limits, undefined, (async () => { throw new Error('called'); }) as typeof fetch), /Unset UKIYO_API_TOKEN/);
}));
test('explicit signup consent pins the reviewed current version, stores the scoped key and prints metadata only', async () => isolated(async () => {
  const document = { version: 'SYNTHETIC_TEST_ONLY', url: 'https://u-kiyo.ai/terms/', sha256: 'a'.repeat(64) };
  const calls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (url.endsWith('/terms')) { assert.equal(new Headers(init.headers).has('authorization'), false); return new Response(JSON.stringify({ data: document })); }
    if (url.endsWith('/signup')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.deepEqual(JSON.parse(String(init.body)), { ...limits, termsAcceptance: { version: document.version, sha256: document.sha256, accepted: true } });
      return new Response(JSON.stringify({ data }));
    }
    return new Response(JSON.stringify({ data: { user: { id: data.account.id }, key: data.key } }));
  }) as typeof fetch;
  const result = await signupAgent(limits, undefined, fetcher, document.version);
  assert.deepEqual(result.termsAcceptance, { version: document.version, sha256: document.sha256 });
  assert.ok(!JSON.stringify(result).includes(token)); assert.equal(calls.length, 3);
}));
test('unapproved or changed Terms never cause automatic agreement or account creation', async () => isolated(async home => {
  for (const document of [null, { version:'SYNTHETIC_OTHER',url:'https://u-kiyo.ai/terms/',sha256:'a'.repeat(64) }, { version:'SYNTHETIC_TEST_ONLY',url:'http://example.test',sha256:'a'.repeat(64) }, { version:'SYNTHETIC_TEST_ONLY',url:'https://u-kiyo.ai/terms/',sha256:'invalid' }]) {
    let requests = 0;
    await assert.rejects(signupAgent(limits, undefined, (async (url: string) => {
      requests++; assert.ok(url.endsWith('/terms')); return new Response(JSON.stringify({data:document}));
    }) as typeof fetch, 'SYNTHETIC_TEST_ONLY'), /Terms|version/);
    assert.equal(requests,1); assert.equal(existsSync(join(home,'.ukiyo/credentials.json')),false);
  }
}));
test('Terms change between metadata and signup preserves backend error and leaves no credential', async () => isolated(async home => {
  let requests = 0;
  await assert.rejects(signupAgent(limits, undefined, (async (url: string) => {
    requests++;
    if(url.endsWith('/terms')) return new Response(JSON.stringify({data:{version:'SYNTHETIC_TEST_ONLY',url:'https://u-kiyo.ai/terms/',sha256:'a'.repeat(64)}}));
    assert.ok(url.endsWith('/signup'));
    return new Response(JSON.stringify({error:{code:'TERMS_ACCEPTANCE_REQUIRED',message:'Explicit agreement to the current Terms is required.'}}),{status:409});
  }) as typeof fetch, 'SYNTHETIC_TEST_ONLY'), (error:any) => error.code==='TERMS_ACCEPTANCE_REQUIRED' && error.status===409);
  assert.equal(requests,2); assert.equal(existsSync(join(home,'.ukiyo/credentials.json')),false);
}));
test('secondary connect prints one approval URL, polls without owner auth, stores only approved scoped key and verifies /me', async () => isolated(async () => {
  const output: string[] = []; let polls = 0; const setupCode = 'uks_' + 'a'.repeat(43);
  const key = { id: 'connected-key', kind: 'AGENT', scopes: ['read', 'rent', 'manage'] };
  const fetcher = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/agent-authorizations')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return new Response(JSON.stringify({ data: { setupCode, approvalUrl: 'https://pay.u-kiyo.ai/connect/' + 'b'.repeat(48), expiresAt: new Date(Date.now() + 600000).toISOString() } }));
    }
    if (url.endsWith('/exchange')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.deepEqual(JSON.parse(String(init.body)), { setupCode });
      if (++polls === 1) return new Response(JSON.stringify({ error: { code: 'AUTHORIZATION_PENDING', message: 'Waiting for account-owner approval.' } }), { status: 409 });
      return new Response(JSON.stringify({ data: { token, key } }));
    }
    assert.equal(url, 'https://pay.u-kiyo.ai/api/v1/me');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    return new Response(JSON.stringify({ data: { key } }));
  }) as typeof fetch;
  const result = await connectExistingAccount(url => output.push(url), undefined, fetcher);
  assert.equal(polls, 2); assert.equal(output.length, 1); assert.ok(!output[0]!.includes(setupCode));
  assert.ok(!JSON.stringify(result).includes(token)); assert.equal(savedCredential('https://pay.u-kiyo.ai'), token);
}));
test('SSH uses native execFile, private temporary key, no agent socket, quoted remote arguments and pinned host; key removed after use', async () => isolated(async home => {
  ensureCredentialDirectory(); let keyFile = '';
  const access = { host: '127.0.0.1', port: 2222, username: 'root', privateKey: 'TEST PRIVATE KEY' };
  const runner = ((file: string, args: string[], options: any, callback: any) => {
    assert.equal(file, 'ssh'); assert.ok(args.includes('BatchMode=yes')); assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
    assert.ok(args.includes('HostKeyAlias=ukiyo-deployment-id')); assert.equal(options.env.UKIYO_API_TOKEN,undefined);assert.equal(options.env.SSH_AUTH_SOCK,undefined);
    if(process.platform!=='win32')assert.deepEqual(Object.keys(options.env), ['PATH']);
    assert.equal(args[args.indexOf('-F')+1],process.platform==='win32'?'NUL':'/dev/null');
    assert.equal(options.shell, undefined); keyFile = args[args.indexOf('-i') + 1]!;
    assert.equal(readFileSync(keyFile, 'utf8'), access.privateKey); assertPrivate(keyFile); assertPrivate(join(keyFile,'..'),true);
    assert.equal(args.at(-1), "'printf' '%s' 'a'\\''b;$(touch /tmp/never)'");
    callback(null, 'ok', '');
  }) as unknown as typeof execFile;
  assert.equal((await executeSsh('deployment-id', access, ['printf', '%s', "a'b;$(touch /tmp/never)"], 60, runner)).exitCode, 0);
  assert.equal(existsSync(keyFile), false);
  await assert.rejects(executeSsh('deployment-id', { ...access, host: '-oProxyCommand=bad' }, ['x']), /Invalid SSH/);
}));
