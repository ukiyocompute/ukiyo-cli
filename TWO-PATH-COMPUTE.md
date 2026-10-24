# Two ways to use Ukiyo compute

## 1. Agents paying with x402 or MPP, no account

Buy a prepaid GPU block or bounded GPU job directly. No Ukiyo signup, API key, SIWX, SIWS or separate authorization endpoint is required. Use a standard client supporting the advertised network, token and scheme:

| Rail | Payment | Example standard client |
| --- | --- | --- |
| Base | x402 v2 exact, USDC | `@x402/fetch` |
| Solana | MPP, USDC; direct token owner | `@solana/mpp` |
| Tempo | MPP, USDC.e | `mppx` |

Stable paid URLs:
- GPU blocks: `POST https://pay.u-kiyo.ai/api/machine/gpu-blocks`
- GPU jobs: `POST https://pay.u-kiyo.ai/api/machine/gpu-jobs`

Anonymous cards and inference are unavailable. The published account CLI, local MCP and Skill below are a separate path; they are not required for these HTTP purchases. Hosted paid MCP is not a public offering.

### Request and payment flow

1. Read [live machine pricing](https://pay.u-kiyo.ai/api/pricing). Use an eligible `offerId`, enabled method, current limits, and the configured Terms and Privacy URLs, versions and SHA-256 hashes. Read and explicitly accept those documents; do not hardcode an old legal snapshot.
2. Generate a P-256 ECDH recovery key pair. Keep the private key securely on the purchaser's device before paying. Send only its public JWK (`kty`, `crv`, `x`, `y`). This is a recovery key, not the payment wallet's private key.
3. POST the purchase body to the appropriate stable URL. The body contains the complete purchase and recovery public key. A block has `kind: "gpu-block"` and no command; a job has `kind: "gpu-job"` and a command. Use a unique `requestId` per new purchase.
4. Read the standard HTTP 402 challenge. Base supplies `PAYMENT-REQUIRED`, with `x402Version: 2`, `resource`, `accepts` and a Bazaar extension. MPP supplies `WWW-Authenticate: Payment`. Check the actual price, network, recipient and request against your authorized budget before signing.
5. The standard client retries **the same URL and identical body**, with `PAYMENT-SIGNATURE` for x402 or `Authorization: Payment` for MPP. Verification and settlement happen in that paid request. Save the response's `purchaseId`, purchase and `accessToken` securely.

Example job body template (replace every placeholder with live values; the recovery coordinates must describe a real P-256 public key):

```json
{
  "requestId": "unique-purchase-id",
  "kind": "gpu-job",
  "offerId": "UUID_FROM_PRICING",
  "durationSeconds": 600,
  "command": "python -c 'print(1 + 1)'",
  "storageGb": 50,
  "maxOutputBytes": 1048576,
  "maxPriceMinor": 500,
  "method": "base",
  "recoveryKey": {"kty": "EC", "crv": "P-256", "x": "PUBLIC_X", "y": "PUBLIC_Y"},
  "termsAcceptance": {"accepted": true, "version": "CURRENT_VERSION", "sha256": "CURRENT_SHA256"},
  "privacyAcceptance": {"accepted": true, "version": "CURRENT_VERSION", "sha256": "CURRENT_SHA256"},
  "source": "organic"
}
```

Use `method: "solana"` or `"tempo"` for MPP. For a block, change the URL and kind and omit `command`. Read the published schema in the 402 Bazaar metadata for validation. An empty or invalid unpaid probe deliberately returns an indicative discovery 402, not a purchase-ready offer. Never pay a crawler's dummy challenge: send valid input first.

### Pricing and caps

Amounts in `maxPriceMinor` are USD cents. The current minimum is $5 (500), maximum $500 (50000), and quote lifetime 60 seconds; read `/api/pricing` for current limits. `hourlyMinor` is a catalog rate, not the final bounded purchase total. Check the returned challenge against your per-purchase cap. Storage, output and provider-cost controls still apply. Work may end earlier when its provider-cost ceiling is reached; requested duration is not a guarantee of that much usable compute time.

**Cloudflare Agents SDK operators must raise the default $0.10 payment cap.** Set `withX402Client`'s `maxPaymentValue` to an explicitly approved amount covering the quote: `5_000_000n` is $5 in USDC atomic units. Increase it only when the authorized quote requires more, and enforce a separate cumulative budget. Check underlying client policy caps too; a wrapper setting may not override them. This is HTTP x402 client guidance, not a hosted Ukiyo MCP announcement.

### Access, recovery and retries

Use `Authorization: Bearer ACCESS_TOKEN` with `POST /api/machine/quotes/{purchaseId}/actions/status` and `POST /api/machine/quotes/{purchaseId}/actions/terminate`. The token grants purchase-scoped status, GPU control and output access. Wait for readiness before using the GPU; confirm termination after cleanup.

If the response is lost, preserve the original body and signed payment and retry it. A 202 `PAYMENT_PENDING` means settlement is unresolved: do not authorize another payment. `GET /api/machine/quotes/{purchaseId}/recovery` returns a JWE encrypted to the original recovery public key after confirmation (or an accurate pending response). Decrypt it with the retained private key to recover the same token. Losing both the token and recovery private key loses recovery access. Never publish tokens, recovery private keys or wallet keys.

Only one valid claim is accepted per settled payment. Duplicate requests do not create another purchase or credit. Already-broadcast payments are reconciled against chain evidence and Stripe confirmation; broadcast alone does not establish entitlement. Payer identities are chain-qualified CAIP-10 identities. Plain x402 retains the standard interception risk: EIP-3009 payment authorization does not sign the purchase body or recovery key, and a copied authorization can race the original purchaser's first valid claim. Exactly-once processing does not remove that risk.

A 403 indicates rejected access; 409 indicates a conflict, unavailable offer or expired quote. An unused expired payment authorization returns terminal 410 `PAYMENT_AUTHORIZATION_EXPIRED`. Reconcile an existing payment before starting a new purchase; never blindly pay again after a timeout.

### Live ghost and stall fallback

After payment, a confirmed ghost listing (`no_such_ask`) or a readiness stall can trigger a compatible replacement: the same GPU model with at least the purchased GPU count, VRAM, RAM and disk, within the paid amount and provider budget. Replacement does not require an identical hourly rate. Ghost asks are excluded from machine pricing and quotes for two hours or until a create succeeds, surviving catalog refreshes.

Provisioning allows up to three real instances within a 360-second total budget; rejected ghost creates do not consume that instance count. A 90-second stage stall without progress triggers cleanup. A stalled instance must be confirmed destroyed before a replacement starts. Repeatedly stalled hosts are excluded from machine selection. Jobs have enforced deadlines and bounded output; status becomes terminated once destruction is confirmed.

If provisioning cannot deliver a fitting instance, the failure path records service credit exactly once, with cleanup reconciled safely. It is not an automatic cash refund. Request a new valid unpaid quote first. Reuse requires `POST /api/machine/quotes/{newPurchaseId}/credits` with the original purchase Bearer token and body `{"sourcePurchaseId":"ORIGINAL_PURCHASE_ID"}`. The destination quote must use the same chain; do not send another payment. Credits and control are not merged across chains or granted merely by supplying a wallet address. Existing legitimate payment-refund reconciliation remains separate.

### Coinbase Bazaar discovery

Both paid routes are listed in Coinbase Bazaar. Inspect the public [search for ukiyo gpu](https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=ukiyo%20gpu) or [merchant lookup](https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=0x9b37cfd6fa912f7a2c546e4a990a94e55d2ebc1d). Listing metadata describes the routes and input schemas; indicative discovery prices are not binding purchase quotes. Read pricing and submit a valid body before authorizing payment.

## 2. Agents and developers using the API with an account

Keep the existing API-key and account-balance workflow: signup with explicit Terms acceptance → store the scoped credential → check balance → fund the account → choose an offer → rent → wait for ACTIVE → execute → terminate → verify. Existing API-key customers and metered rentals are unchanged. `UKIYO_API_URL` is `https://pay.u-kiyo.ai`; use the account route schemas in the [API guide](https://docs.u-kiyo.ai/connect/api).

| Existing tool | Pinned version | Documentation / artifact |
| --- | --- | --- |
| CLI command `ukiyo` | 0.2.5 | [CLI guide](https://docs.u-kiyo.ai/connect/cli) · [release](https://u-kiyo.ai/releases/cli/0.2.5/ukiyo-cli-0.2.5.mjs) |
| Local stdio MCP command `ukiyo-mcp` | 0.2.0 | [MCP guide](https://docs.u-kiyo.ai/connect/mcp) · [release](https://u-kiyo.ai/releases/mcp/0.2.0/ukiyo-mcp-0.2.0.mjs) |
| Skill `ukiyo-compute` | 1.0.1 | [Skill guide](https://docs.u-kiyo.ai/connect/skill) · [pinned artifact](https://u-kiyo.ai/releases/skill/1.0.1/ukiyo-compute/SKILL.md) |

These are existing release downloads; no new npm packages or versions are introduced. Verify release checksums before installation. CLI SHA-256: `3328a07d01808f6a48343eb2af1cf86cc040f3b05b0077dc02857ec7538bee85`. MCP SHA-256: `e32c8b638856c16eb8315b9d086c8c39d88f7ac89f1b0cd311bf7a7a18de81a1`. Pinned Skill 1.0.1 SHA-256: `719fca36ec699aecd30f391c307703a9935aa56f510f8cc8803546f06c37fddf`.

Skill 1.0.1 is an intentional pin, not the latest manifest version. Its immutable instructions reference CLI 0.2.2; retain the separately installed CLI 0.2.5 rather than downgrading it. This documentation does not rewrite that published artifact. The published account tools do not acquire new wallet-payment commands from this docs update.
