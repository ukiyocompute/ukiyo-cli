#!/usr/bin/env node
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { ApiError, dollarsToMinor, UkiyoClient } from "./client.js";
import { connectAgent, connectExistingAccount, signupAgent, savedCredential, apiOrigin } from './credentials.js';
import { executeSsh, type SshAccess } from './ssh.js';
import { safeOutput } from './output.js';
import { timeoutSeconds, waitFor } from './wait.js';

function filteredOffers(value: unknown, gpu?: string, count?: string) {
  const normalize = (name: string) => name.toUpperCase().replace(/NVIDIA|AMD/g, '').replace(/[^A-Z0-9]/g, '');
  if (count !== undefined && (!Number.isSafeInteger(Number(count)) || Number(count) < 1)) throw new ApiError(0, 'INVALID_USAGE', 'GPU count must be a positive integer.', null);
  if (!Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', 'Expected an offer list from the API.', null);
  return value.filter(offer => (!gpu || normalize(offer.name) === normalize(gpu)) && (count === undefined || offer.gpuCount === Number(count)));
}
function contextError(error: unknown, context: Record<string, unknown>): never {
  const failure = error instanceof ApiError ? error : new ApiError(0, 'CLI_ERROR', (error as Error).message, null);
  failure.context = { ...context, ...failure.context }; throw failure;
}

export function buildProgram(options: { client?: UkiyoClient; out?: (line: string) => void } = {}) {
  const out = options.out ?? console.log;
  const client = () => {
    if (options.client) return options.client;
    const baseUrl = apiOrigin(process.env.UKIYO_API_URL);
    const token = process.env.UKIYO_API_TOKEN ?? savedCredential(baseUrl);
    return new UkiyoClient({ baseUrl, ...(token ? { token } : {}) });
  };
  const print = (value: unknown) => out(JSON.stringify(safeOutput(value), null, 2));

  const program = new Command()
    .name("ukiyo")
    .description("Manage Ukiyo compute through the public API")
    .version("0.2.5")
    .configureOutput({ writeErr: () => {} })
    .exitOverride();

  program.command("auth")
    .description("Explain API token authentication")
    .action(() => out([
      "New agent: ukiyo signup --json (no account, email, browser or Telegram required).",
      "Review https://u-kiyo.ai/terms/ and https://u-kiyo.ai/privacy/ first. If the server requires consent, explicitly use signup --accept-terms <current-version> --json (GET /api/v1/terms provides the version and hash).",
      "Existing human-owned account: ukiyo connect, then ask its owner to approve the displayed URL.",
      "Fund once: ukiyo balance --json; ukiyo topup link --amount 5 --json.",
      "Ukiyo authenticates with a scoped API token.",
      "",
      "No owner credential is needed by the CLI/agent. Do not copy an owner token into its environment.",
      "",
      "Optional: export UKIYO_API_URL to target a different environment.",
      "signup/connect store only the scoped agent token in ~/.ukiyo/credentials.json (0600). Never give an agent an owner token."
    ].join("\n")));

  program.command('connect [setup-code]')
    .option('--json')
    .description('Attach to an existing owner account using a short-lived approval session')
    .action(async (setupCode?: string) => {
      const result = setupCode ? await connectAgent(setupCode, process.env.UKIYO_API_URL) : await connectExistingAccount(console.error, process.env.UKIYO_API_URL);
      print({ connected: true, key: result.key, credentialFile: result.path });
    });

  program.command('signup').description('Create a new headless account and scoped agent credential; no free credits')
    .option('--json').option('--max-per-rental <usd>', 'per-rental spending cap', '5')
    .option('--budget <usd>', 'total net spending cap', '500').option('--max-concurrent <count>', 'concurrent rental cap', '1')
    .option('--accept-terms <version>', 'explicitly agree to the reviewed current version from GET /api/v1/terms; never inferred')
    .addHelpText('after', '\nReview https://u-kiyo.ai/terms/ and https://u-kiyo.ai/privacy/. An authorized agent may agree once at signup; no per-rental approval is required.')
    .action(async opts => print(await signupAgent({ maxPerRentalMinor: dollarsToMinor(opts.maxPerRental), budgetLimitMinor: dollarsToMinor(opts.budget), maxConcurrentDeployments: Number(opts.maxConcurrent) }, process.env.UKIYO_API_URL, undefined, opts.acceptTerms)));
  program.command('me').option('--json').action(async () => print(await client().me()));
  program.command('balance').option('--json').action(async () => {
    const account = await client().me() as { balance: object; key: object };
    print({ ...account.balance, key: account.key });
  });
  program.command('topup').description('Fund your own compute-credit balance').command('link').requiredOption('--amount <usd>').option('--json')
    .option('--idempotency-key <key>', 'reuse this key after a timeout')
    .action(async opts => {
      const key = opts.idempotencyKey ?? randomUUID();
      try { print({ ...await client().topup(dollarsToMinor(opts.amount), key) as object, idempotencyKey: key }); }
      catch (error) { contextError(error, { idempotencyKey: key }); }
    });
  program.command('rent').option('--offer <id>').option('--gpu <name>').option('--count <count>')
    .option('--budget <usd>', 'required for fixed-prepaid accounts; optional for account-balance billing').option('--max-hourly-price <usd>', 'GPU/count accepted hourly ceiling; reuse the same ceiling on retries')
    .option('--idempotency-key <key>', 'unique per intended rental; reuse with original parameters on retries').option('--json')
    .option('--wait').option('--timeout <seconds>', 'maximum status wait', '600')
    .action(async opts => {
      const seconds = timeoutSeconds(opts.timeout);
      const budget = opts.budget === undefined ? undefined : dollarsToMinor(opts.budget);
      if (Boolean(opts.offer) === Boolean(opts.gpu) || (opts.offer && (opts.count || opts.maxHourlyPrice))) throw new ApiError(0, 'INVALID_USAGE', 'Choose --offer OR --gpu with optional --count and hourly ceiling.', null);
      const api = client();
      if (budget === undefined) {
        const account = await api.me() as { billing?: { model?: string; budgetRequired?: boolean } };
        // Fail closed against old servers and legacy accounts. Never synthesize
        // a budget or infer eligibility from a balance; admission stays server-side.
        if (account.billing?.model !== 'ACCOUNT_BALANCE' || account.billing.budgetRequired !== false) {
          throw new ApiError(0, 'INVALID_USAGE', '--budget is required for this account. Budget-free rentals require account-balance billing.', null);
        }
      }
      const budgetFields = budget === undefined ? {} : { budgetMinor: budget };
      let intent: { gpuModel: string; gpuCount: number; budgetMinor?: number; maxHourlyPriceMinor: number } | undefined;
      if (opts.gpu) {
        const count = opts.count ?? '1';
        if (![1, 2, 4, 8].includes(Number(count))) throw new ApiError(0, 'INVALID_USAGE', 'Supported GPU counts are 1, 2, 4 or 8.', null);
        // Read a customer quote only; never bind GPU/count intent to a marketplace
        // row. Selection and exact verification belong solely to the backend.
        const quoted = opts.maxHourlyPrice ? dollarsToMinor(opts.maxHourlyPrice) :
          filteredOffers(await api.offers(), opts.gpu, count).filter(o => o.currency === 'USD')
            .sort((a, b) => a.pricePerHourMinor - b.pricePerHourMinor)[0]?.pricePerHourMinor;
        if (!Number.isSafeInteger(quoted) || quoted < 1) throw new ApiError(0, 'NO_MATCHING_OFFER', 'No valid customer quote matches this GPU/count. Supply an accepted --max-hourly-price to retain it on retries.', null);
        intent = { gpuModel: opts.gpu, gpuCount: Number(count), ...budgetFields, maxHourlyPriceMinor: quoted };
      }
      const idempotencyKey = opts.idempotencyKey ?? randomUUID();
      const context: Record<string, unknown> = { ...(intent ?? { offerId: opts.offer, ...budgetFields }), idempotencyKey };
      try {
        const rental = await (intent ? api.rentGpu(intent, idempotencyKey) : api.rent(opts.offer, budget, idempotencyKey)) as any;
        Object.assign(context, { rentalId: rental.rentalId, deploymentId: rental.deploymentId });
        const result = opts.wait && !['ACTIVE', 'FAILED', 'TERMINATED'].includes(rental.status)
          ? await waitFor(signal => api.rental(rental.rentalId, signal), value => ['ACTIVE', 'FAILED', 'TERMINATED'].includes(value.status), seconds, context) : rental;
        print({ ...result, ...context });
        if (opts.wait && result.status !== 'ACTIVE') process.exitCode = 1;
      } catch (error) { contextError(error, context); }
    });
  program.command('rental <id>').option('--json').option('--wait', 'wait for ACTIVE or a final failure').option('--timeout <seconds>', 'maximum wait', '600')
    .action(async (id, opts) => {
      const seconds = timeoutSeconds(opts.timeout); const api = client();
      const value = opts.wait ? await waitFor(signal => api.rental(id, signal), value => ['ACTIVE', 'FAILED', 'TERMINATED'].includes(value.status), seconds, { rentalId: id }) : await api.rental(id);
      print(value); if (opts.wait && (value as any).status !== 'ACTIVE') process.exitCode = 1;
    });
  program.command('exec <id> <command...>').option('--json').option('--timeout <seconds>', 'command timeout', '60')
    .description('Execute a command over authenticated SSH (first host key is pinned locally)')
    .action(async (id: string, command: string[], opts) => {
      const seconds = timeoutSeconds(opts.timeout);
      const access = await client().credentials(id) as SshAccess;
      const result = await executeSsh(id, access, command, seconds); print({ deploymentId: id, ...result }); if (result.exitCode) process.exitCode = 1;
    });

  program.command("offers").option('--json').option('--gpu <name>').option('--count <count>').description("List available compute")
    .action(async opts => print(filteredOffers(await client().offers(), opts.gpu, opts.count)));
  program.command("list").option('--json').description("List your deployments").action(async () => print(await client().deployments()));
  program.command("status <id>").option('--json').description("Show one deployment").action(async (id: string) => print(await client().deployment(id)));

  program.command("credentials <id>")
    .option('--json').description("Show connection metadata; use exec for private-key authentication")
    .action(async (id: string) => print(await client().credentials(id)));

  program.command("deploy")
    .description("Rent an offer")
    .requiredOption("--offer <id>")
    .requiredOption("--budget <usd>", "budget in dollars, e.g. 20 or 19.99")
    .action(async (opts: { offer: string; budget: string }) => print(await client().checkout(opts.offer, dollarsToMinor(opts.budget), randomUUID())));

  program.command("terminate <id>")
    .option('--json')
    .option('--wait').option('--timeout <seconds>', 'maximum termination wait', '600')
    .description("Terminate a deployment. This is irreversible.")
    .option("--yes", "skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean; wait?: boolean; timeout: string }) => {
      const seconds = timeoutSeconds(opts.timeout);
      if (!opts.yes) throw new ApiError(0, "CONFIRMATION_REQUIRED", `Terminating ${id} is irreversible and destroys anything on the instance. Re-run with --yes to confirm.`, null);
      const api = client();
      try {
        const accepted = await api.terminate(id);
        const value = opts.wait ? await waitFor(signal => api.deployment(id, signal), value => value.status === 'TERMINATED', seconds, { deploymentId: id }) : accepted;
        print({ ...value as object, deploymentId: id });
      } catch (error) { contextError(error, { deploymentId: id }); }
    });

  return program;
}

/** Entry point used by bin.ts. Maps thrown errors onto a clean exit code. */
export async function run(argv: string[] = process.argv) {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    const commander = (error as any)?.code?.startsWith?.('commander.');
    if (commander && (error as any).exitCode === 0) return;
    const api = error instanceof ApiError ? error : undefined;
    process.exitCode = api?.code === 'WAIT_TIMEOUT' ? 3 : commander || ['INVALID_USAGE', 'INVALID_BUDGET', 'CONFIRMATION_REQUIRED'].includes(api?.code ?? '') ? 2 : 1;
    const result = safeOutput({ error: { code: api?.code ?? (commander ? 'INVALID_USAGE' : 'CLI_ERROR'), status: api?.status ?? 0, message: (error as Error).message, requestId: api?.requestId ?? null }, ...api?.context });
    if (argv.slice(0, argv.indexOf('--') < 0 ? undefined : argv.indexOf('--')).includes('--json')) console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
  }
}
