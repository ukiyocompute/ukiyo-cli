# Ukiyo CLI

## 1. Agents paying with x402 or MPP, no account

Buy GPU blocks at `POST https://pay.u-kiyo.ai/api/machine/gpu-blocks` or jobs at `POST https://pay.u-kiyo.ai/api/machine/gpu-jobs`. Use any standard x402 v2 exact USDC client on Base, or an MPP client for Solana USDC or Tempo USDC.e. No signup or API key is required.

Read [pricing](https://pay.u-kiyo.ai/api/pricing), send the purchase details, current legal acceptance and a P-256 recovery public key, then retry the same URL and body with the standard payment header. Save the returned access token and retain the recovery private key. Read the [complete payment, recovery and Bazaar guide](https://docs.u-kiyo.ai/connect/machine-payments) before paying.

Cloudflare operators: raise the default $0.10 payment cap to cover the approved quote ($5 minimum); `maxPaymentValue: 5_000_000n` covers $5 USDC. Keep a cumulative budget. Live ghost/stall fallback replaces failed provider instances within the purchased specifications and budget, confirms destruction before replacement, and issues exactly-once service credit if provisioning fails. Anonymous cards and inference are unavailable.

## 2. Agents and developers using the API with an account

The existing API-key/account-balance flow is unchanged: CLI `ukiyo` 0.2.5, local MCP `ukiyo-mcp` 0.2.0 and pinned Skill `ukiyo-compute` 1.0.1. These are existing release downloads, not new npm releases. The account instructions below apply to this path. Skill 1.0.1's immutable artifact references CLI 0.2.2; keep the separately installed CLI 0.2.5. See the full guide for artifact links and checksums.


Rent a dedicated GPU from your terminal, or let your AI agent do it. Pick a GPU, fund your balance once, and connect over SSH in about a minute.

**Current version: 0.2.5** · [Docs](https://docs.u-kiyo.ai/connect/cli) · [Website](https://u-kiyo.ai) · [Live GPU prices](https://u-kiyo.ai/gpu/)

## Install

Requires [Node.js 22+](https://nodejs.org). The installers download the release, check its SHA-256 and stop if it doesn't match.

**macOS / Linux / WSL**

```bash
curl -fsSL https://u-kiyo.ai/releases/cli/0.2.5/install.sh | sh
```

**Windows (PowerShell)**: downloads the installer, checks its SHA-256, then runs it.

```powershell
$release = Invoke-RestMethod https://u-kiyo.ai/releases/latest.json
$installer = $release.tools.cli.files | Where-Object { $_.path -eq 'cli/0.2.5/install.ps1' }
$path = Join-Path $env:TEMP 'ukiyo-install-0.2.5.ps1'
Invoke-WebRequest -UseBasicParsing $installer.url -OutFile $path
if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installer.sha256) { throw 'Checksum mismatch; stop here.' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
```

Add `~/.local/bin` (macOS/Linux) to your `PATH` if asked, open a new terminal and run `ukiyo --version`. Prefer to verify every step by hand? See [INSTALL.md](INSTALL.md).

## Quick start

```bash
ukiyo signup --accept-terms 2026-10-10 --json   # new account; read https://u-kiyo.ai/terms/ first
ukiyo topup link --amount 5 --json              # open the link to add credit (once, by a person)
ukiyo offers --json                             # live GPUs and prices
ukiyo rent --gpu RTX4090 --count 1 --wait --json
ukiyo exec <deployment-id> -- nvidia-smi        # run a command over SSH
ukiyo terminate <deployment-id> --json          # stop paying
```

- `signup` creates a new account and stores a scoped agent key on your machine. No email or browser needed.
- Account-balance rentals don't need `--budget`; they stop automatically when your balance runs low.
- Run `ukiyo --help` or `ukiyo <command> --help` for every option.

## Billing in one minute

- One shared balance pays for all your rentals: GPU and storage at the hourly price shown, plus data transfer by volume.
- Unused credit stays in your balance. Final charges settle a few minutes after a rental ends.
- A rental that fails before it becomes usable is not charged.

Full details: [Billing](https://docs.u-kiyo.ai/guides/billing) · [Terms](https://u-kiyo.ai/terms/) · [Privacy](https://u-kiyo.ai/privacy/)

## Verify a download

Every published file is listed with its SHA-256 in [SHA256SUMS](https://u-kiyo.ai/releases/SHA256SUMS) and [latest.json](https://u-kiyo.ai/releases/latest.json). The same files are attached to this repository's [Releases](https://github.com/ukiyocompute/ukiyo-cli/releases).

| File | SHA-256 |
| --- | --- |
| `ukiyo-cli-0.2.5.mjs` | `3328a07d01808f6a48343eb2af1cf86cc040f3b05b0077dc02857ec7538bee85` |

## Build from source

```bash
npm install
npm test             # 61 tests
npm run release      # writes dist/release/ukiyo-cli-0.2.5.mjs and the installers
```

The bundle you build matches the published file except for the module path labels esbuild writes next to each bundled file.

## Related

- [ukiyo-mcp](https://github.com/ukiyocompute/ukiyo-mcp): the same actions as an MCP server
- [ukiyo-skill](https://github.com/ukiyocompute/ukiyo-skill): an agent skill that teaches the workflow
- [ukiyo-api](https://github.com/ukiyocompute/ukiyo-api): the HTTP API and OpenAPI spec
- [ukiyo-guides](https://github.com/ukiyocompute/ukiyo-guides): step-by-step guides

## Support and security

Questions or a security report: **contact@u-kiyo.ai**. Please don't include API keys or private keys in issues.

## License

[MIT](LICENSE) © 2026 Ukiyo Compute LLC. The license covers this client software, not the Ukiyo service, which is governed by the [Terms](https://u-kiyo.ai/terms/).
