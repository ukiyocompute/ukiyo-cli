import { ApiError } from './client.js';

export function timeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new ApiError(0, 'INVALID_USAGE', 'Timeout must be 1–3600 seconds.', null);
  return seconds;
}

export async function waitFor(read: (signal: AbortSignal) => Promise<unknown>, done: (value: any) => boolean, seconds: number, context: Record<string, unknown>) {
  const deadline = Date.now() + seconds * 1000;
  let latest: any;
  const timedOut = () => {
    const error = new ApiError(0, 'WAIT_TIMEOUT', 'Wait ended; the resource still exists. Inspect the known ID. Do not create a replacement rental.', null);
    error.context = { ...context, ...(latest ? { resource: latest } : {}) };
    return error;
  };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    try { latest = await read(AbortSignal.timeout(Math.max(1, Math.min(15000, remaining)))); }
    catch (error) {
      if (Date.now() >= deadline) throw timedOut();
      if (error instanceof ApiError) error.context = { ...context, ...error.context };
      throw error;
    }
    if (latest?.rentalId) context.rentalId = latest.rentalId;
    if (latest?.deploymentId) context.deploymentId = latest.deploymentId;
    if (done(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now()))));
  }
}
