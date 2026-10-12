/** Defense in depth for customer/remote text; credentials never belong in CLI output. */
export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
  return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/uk_[a-f0-9]{12}\.[A-Za-z0-9_-]{32,}/g, '[REDACTED TOKEN]');
}
export function safeOutput(value: unknown): unknown {
  if (typeof value === 'string') return redact(value, [process.env.UKIYO_API_TOKEN ?? '']);
  if (Array.isArray(value)) return value.map(safeOutput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:privateKey|private_key|token|secret|password|authorization)$/i.test(key) ? '[REDACTED]' : safeOutput(item)]));
  return value;
}
