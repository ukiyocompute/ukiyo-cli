/**
 * Thin transport over the Ukiyo public API. The CLI holds no business logic:
 * every decision stays server-side so the CLI can never disagree with the bot.
 */
export type ClientOptions = { baseUrl?: string; token?: string; fetcher?: typeof fetch };

export class ApiError extends Error {
  context: Record<string, unknown> = {};
  readonly requestId: string | undefined;
  constructor(readonly status: number, readonly code: string, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
    this.requestId = (body as any)?.error?.requestId ?? (body as any)?.requestId ?? (body as any)?.meta?.requestId;
  }
}

export class UkiyoClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://pay.u-kiyo.ai").replace(/\/+$/, "");
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  async request<T = unknown>(path: string, init: RequestInit & { authenticated?: boolean } = {}): Promise<T> {
    const { authenticated = true, headers, ...rest } = init;
    if (authenticated && !this.token) {
      throw new ApiError(0, "UNAUTHENTICATED", "No API token. New account: ukiyo signup --json. Existing human-owned account: ukiyo connect. Never give an agent an owner token.", null);
    }
    const signal = rest.signal ?? AbortSignal.timeout(15000);
    let response: Response;
    try { response = await this.fetcher(`${this.baseUrl}/api/v1${path}`, {
      ...rest,
      signal,
      redirect: 'error',
      headers: {
        // Only declare a JSON body when there is one. A bodyless POST that
        // still claims application/json is rejected before it reaches a route.
        ...(rest.body === undefined ? {} : { "content-type": "application/json" }),
        ...(authenticated && this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers
      }
    }); } catch { throw new ApiError(0, 'NETWORK_ERROR', 'API request failed or timed out. For a write, retry only with the same Idempotency-Key and original parameters.', null); }
    const body = await response.json().catch(() => null);
    if (signal.aborted) throw new ApiError(0, 'NETWORK_ERROR', 'API response timed out. Retry writes only with the same Idempotency-Key and original parameters.', null);
    if (!response.ok) {
      const code = (body as any)?.error?.code ?? (body as any)?.code ?? `HTTP_${response.status}`;
      const message = (body as any)?.error?.message ?? (body as any)?.message ?? describe(response.status);
      throw new ApiError(response.status, String(code), String(message), body);
    }
    if (body === null) throw new ApiError(response.status, 'INVALID_RESPONSE', 'API did not return a JSON response.', null);
    return ((body as any)?.data ?? body) as T;
  }

  offers() { return this.request("/offers", { authenticated: false }); }
  me() { return this.request('/me'); }
  balance() { return this.request('/billing/balance'); }
  topup(amountMinor: number, idempotencyKey: string) { return this.request('/billing/topups', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ amountMinor }) }); }
  rent(offerId: string, budgetMinor: number | undefined, idempotencyKey: string) { return this.request('/rentals', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify({ offerId, ...(budgetMinor === undefined ? {} : { budgetMinor }) }) }); }
  rentGpu(input: { gpuModel: string; gpuCount: number; budgetMinor?: number; maxHourlyPriceMinor: number }, idempotencyKey: string) { return this.request('/rentals', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) }); }
  rental(id: string, signal?: AbortSignal) { return this.request(`/rentals/${encodeURIComponent(id)}`, signal ? { signal } : {}); }
  deployments() { return this.request("/deployments"); }
  deployment(id: string, signal?: AbortSignal) { return this.request(`/deployments/${encodeURIComponent(id)}`, signal ? { signal } : {}); }
  credentials(id: string) { return this.request(`/deployments/${encodeURIComponent(id)}/credentials/reveal`, { method: "POST" }); }
  terminate(id: string) { return this.request(`/deployments/${encodeURIComponent(id)}/terminate`, { method: "POST", body: JSON.stringify({ reason: "USER_REQUESTED" }) }); }
  checkout(offerId: string, budgetMinor: number, idempotencyKey: string) {
    return this.request("/orders/checkout", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ offerId, budgetMinor }) });
  }
}

function describe(status: number) {
  if (status === 401) return "Invalid or expired API token. Check the saved credential and API origin. Existing-account agents can reconnect with owner approval; do not create a new account to recover a funded balance.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Rate limited. Try again shortly.";
  return `Request failed with status ${status}.`;
}

/** Dollars to minor units without floating-point drift ("1.005" must not round to 100). */
export function dollarsToMinor(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new ApiError(0, "INVALID_BUDGET", `Budget must be a dollar amount such as 20 or 19.99, received "${value}".`, null);
  const [whole, fraction = ""] = value.trim().split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new ApiError(0, 'INVALID_BUDGET', 'Amount exceeds safe integer precision.', null);
  return minor;
}
