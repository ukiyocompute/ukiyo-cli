import { constants, closeSync, fsyncSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from './client.js';
import { randomUUID } from 'node:crypto';
import {credentialDirectory,ensureCredentialDirectory,openPrivateFile,validateStoragePath} from './storage.js';

export const DEFAULT_API_URL = 'https://pay.u-kiyo.ai';
export function apiOrigin(value = DEFAULT_API_URL): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS API origin (HTTP is allowed only on loopback for local testing).');
  }
  return url.origin;
}
const directory = credentialDirectory;
const filename = () => join(directory(), 'credentials.json');
export function savedCredential(baseUrl: string): string | undefined {
  try { validateStoragePath(directory(), true); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  let fd: number;
  try { fd = openPrivateFile(filename(), constants.O_RDONLY); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    // Never send a saved production token to a different API origin.
    if (data.apiUrl !== apiOrigin(baseUrl)) throw new Error('Saved credential belongs to a different API origin.');
    if (typeof data.token !== 'string' || !/^uk_[a-f0-9]{12}\.[A-Za-z0-9_-]{32}$/.test(data.token)) throw new Error('Invalid saved Ukiyo credential.');
    return data.token;
  } finally { closeSync(fd); }
}

export async function connectAgent(setupCode: string, baseUrl = DEFAULT_API_URL, fetcher: typeof fetch = fetch) {
  const apiUrl = apiOrigin(baseUrl);
  if (!/^uks_[A-Za-z0-9_-]{43}$/.test(setupCode)) throw new Error('Invalid setup code. Ask the owner for a fresh Connect an agent code.');
  if (process.env.UKIYO_API_TOKEN) throw new Error('Unset UKIYO_API_TOKEN before connecting. Only the scoped agent credential should be used.');
  ensureCredentialDirectory();
  // Reserve a private file BEFORE consuming the code. Never silently overwrite
  // another identity or follow a symlink, including during concurrent connects.
  const fd = openPrivateFile(filename(), constants.O_WRONLY, true);
  let stored = false;
  try {
    const response = await fetcher(`${apiUrl}/api/v1/agent-setups/exchange`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode })
    });
    const body = await response.json() as any;
    if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'CONNECT_FAILED', body?.error?.message ?? 'Connection failed.', body);
    if (body?.data?.key?.kind !== 'AGENT' || !/^uk_[a-f0-9]{12}\.[A-Za-z0-9_-]{32}$/.test(body?.data?.token ?? '') ||
        JSON.stringify([...(body?.data?.key?.scopes ?? [])].sort()) !== JSON.stringify(['manage', 'read', 'rent'])) throw new Error('Server did not return the expected scoped agent credential.');
    writeFileSync(fd, JSON.stringify({ apiUrl, token: body.data.token, keyId: body.data.key.id }) + '\n', { flush: true });
    fsyncSync(fd);
    stored = true;
    return { key: body.data.key, path: filename() };
  } catch (error) {
    // A lost response may have consumed the code. Never automatically exchange
    // again or issue a replacement token. The owner can revoke it with /tokens.
    if (error instanceof ApiError) throw error;
    throw new Error(`${error instanceof Error ? error.message : 'Connection failed.'} If the code was consumed, ask the owner to revoke the agent token and create a new setup code.`);
  } finally {
    closeSync(fd);
    if (!stored) unlinkSync(filename());
  }
}

export async function connectExistingAccount(printUrl: (url: string) => void, baseUrl = DEFAULT_API_URL, fetcher: typeof fetch = fetch) {
  const apiUrl = apiOrigin(baseUrl);
  if (process.env.UKIYO_API_TOKEN || savedCredential(apiUrl)) throw new Error('Already authenticated. Use a fresh HOME for an additional agent; do not replace an existing identity.');
  const response = await fetcher(`${apiUrl}/api/v1/agent-authorizations`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.json() as any;
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'CONNECT_FAILED', body?.error?.message ?? 'Could not start authorization.', body);
  const session = body.data;
  const approval = new URL(session.approvalUrl);
  if (approval.origin !== apiUrl || !/^\/connect\/[a-f0-9]{48}$/.test(approval.pathname)) throw new Error('Unexpected approval URL.');
  printUrl(approval.href);
  const deadline = Math.min(Date.now() + 600000, Date.parse(session.expiresAt));
  while (Date.now() < deadline) {
    try {
      const result = await connectAgent(session.setupCode, apiUrl, fetcher);
      const token = savedCredential(apiUrl);
      const me = await fetcher(`${apiUrl}/api/v1/me`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!me.ok || (await me.json() as any)?.data?.key?.id !== result.key.id) throw new Error('Credential saved; verification failed. Retry ukiyo me.');
      return result;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Waiting for account-owner approval.')) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error('Authorization expired. Run ukiyo connect again.');
}

export async function signupAgent(limits: { maxPerRentalMinor: number; budgetLimitMinor: number; maxConcurrentDeployments: number }, baseUrl = DEFAULT_API_URL, fetcher: typeof fetch = fetch, acceptedTermsVersion?: string) {
  const apiUrl = apiOrigin(baseUrl);
  if (process.env.UKIYO_API_TOKEN) throw new Error('Unset UKIYO_API_TOKEN before signup; signup creates a new account, never attaches to an existing one.');
  ensureCredentialDirectory();
  const fd = openPrivateFile(filename(), constants.O_WRONLY, true);
  let stored = false;
  try {
    let agreedTerms: { version: string; sha256: string } | undefined;
    if (acceptedTermsVersion !== undefined) {
      // The caller explicitly chooses a version after reviewing it. Fetching
      // metadata alone is never agreement; changed/unpublished Terms fail closed.
      const response = await fetcher(`${apiUrl}/api/v1/terms`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      const body = await response.json() as any;
      if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'TERMS_UNAVAILABLE', body?.error?.message ?? 'Approved Terms are unavailable.', body);
      const document = body?.data;
      if (!document || typeof document.version !== 'string' || !/^https:\/\//.test(document.url ?? '') || !/^[a-f0-9]{64}$/.test(document.sha256 ?? '')) throw new ApiError(0, 'TERMS_UNAVAILABLE', 'Approved Terms are not configured. Signup was not attempted.', null);
      if (document.version !== acceptedTermsVersion) throw new ApiError(0, 'TERMS_VERSION_MISMATCH', 'Review GET /api/v1/terms and explicitly supply its current version with --accept-terms. Signup was not attempted.', null);
      agreedTerms = { version: document.version, sha256: document.sha256 };
    }
    const response = await fetcher(`${apiUrl}/api/v1/signup`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ ...limits, ...(agreedTerms ? { termsAcceptance: { ...agreedTerms, accepted: true } } : {}) }) });
    const body = await response.json() as any;
    if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? 'SIGNUP_FAILED', body?.error?.message ?? 'Signup failed.', body);
    const data = body.data;
    if (data?.key?.kind !== 'AGENT' || !/^uk_[a-f0-9]{12}\.[A-Za-z0-9_-]{32}$/.test(data?.token ?? '') ||
        JSON.stringify([...(data?.key?.scopes ?? [])].sort()) !== JSON.stringify(['billing', 'manage', 'read', 'rent'])) throw new Error('Unexpected signup credential.');
    writeFileSync(fd, JSON.stringify({ apiUrl, token: data.token, keyId: data.key.id }) + '\n'); fsyncSync(fd); stored = true;
    // Verify after durable storage. A transient /me failure must not destroy
    // the only credential for the new account; `ukiyo me` can retry it safely.
    const me = await fetcher(`${apiUrl}/api/v1/me`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${data.token}` } });
    if (!me.ok) throw new Error('Credential saved, but verification failed. Retry ukiyo me --json; do not sign up again.');
    const identity = (await me.json() as any).data;
    if (identity?.user?.id !== data.account.id || identity?.key?.id !== data.key.id || identity?.key?.kind !== 'AGENT') throw new Error('Saved credential identity did not match signup.');
    return { account: data.account, key: data.key, credentialFile: filename(), ...(agreedTerms ? { termsAcceptance: agreedTerms } : {}) };
  } finally { closeSync(fd); if (!stored) unlinkSync(filename()); }
}
