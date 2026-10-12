# Ukiyo CLI 0.2.5

Use Node.js 22 or newer and a native OpenSSH client (`ssh`). The same CLI commands work in Windows PowerShell, macOS and Linux. WSL is Linux: use the Unix instructions, preferably with your WSL home on its Linux filesystem, not under `/mnt/c`.

## Windows PowerShell

Install Node.js from https://nodejs.org. Enable **OpenSSH Client** under Windows **Settings → System → Optional features** if `Get-Command ssh` fails. No administrator session is required to install the CLI itself.

```powershell
$release = Invoke-RestMethod https://u-kiyo.ai/releases/latest.json
$installer = $release.tools.cli.files | Where-Object { $_.path -eq 'cli/0.2.5/install.ps1' }
if (-not $installer) { throw 'CLI 0.2.5 installer not found; stop here.' }
$path = Join-Path $env:TEMP 'ukiyo-install-0.2.5.ps1'
Invoke-WebRequest -UseBasicParsing $installer.url -OutFile $path
if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installer.sha256) { throw 'Installer checksum mismatch; stop here.' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
```

Open a new terminal, then run `ukiyo --version` and `ukiyo signup --json`. The installer puts the CLI and `ukiyo.cmd` launcher in `%LOCALAPPDATA%\Ukiyo\bin` and adds that directory to your user PATH. Credentials remain in `%USERPROFILE%\.ukiyo\credentials.json`, with inheritance disabled and access limited to your user SID. Windows does not use POSIX permission bits. The CLI fails closed if it cannot establish or verify the required ACLs; it never overwrites an existing identity.

If an older failed signup left an empty `.ukiyo` directory, remove **only that empty directory** with `[IO.Directory]::Delete((Join-Path $env:USERPROFILE '.ukiyo'), $false)` and retry. This refuses a nonempty directory. Never delete an existing credential. For existing credentials with unsafe ACLs, repair their access controls deliberately; do not sign up again or replace the account.

## macOS / Linux / WSL

Alternatively, download the versioned `cli/0.2.5/install.sh` entry from
`https://u-kiyo.ai/releases/latest.json`, verify its SHA-256 against that entry,
then run `sh install.sh`. It verifies the CLI checksum before installing and
does not create an account or credential. The manual equivalent follows.

```sh
mkdir -p "$HOME/.local/share/ukiyo" "$HOME/.local/bin"
curl -fSL https://u-kiyo.ai/releases/cli/0.2.5/ukiyo-cli-0.2.5.mjs -o "$HOME/.local/share/ukiyo/ukiyo-cli-0.2.5.mjs"
curl -fSL https://u-kiyo.ai/releases/SHA256SUMS -o "$HOME/.local/share/ukiyo/SHA256SUMS"
expected=$(awk '$2 == "cli/0.2.5/ukiyo-cli-0.2.5.mjs" { print $1 }' "$HOME/.local/share/ukiyo/SHA256SUMS")
test -n "$expected" || exit 1
cd "$HOME/.local/share/ukiyo" || exit 1
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$expected" ukiyo-cli-0.2.5.mjs | sha256sum -c - || exit 1
else
  printf '%s  %s\n' "$expected" ukiyo-cli-0.2.5.mjs | shasum -a 256 -c - || exit 1
fi
printf '%s\n' '#!/bin/sh' 'exec node "$HOME/.local/share/ukiyo/ukiyo-cli-0.2.5.mjs" "$@"' > "$HOME/.local/bin/ukiyo"
chmod 755 "$HOME/.local/bin/ukiyo"
export PATH="$HOME/.local/bin:$PATH"
ukiyo --version
```

Keep `$HOME/.local/bin` on PATH in future terminals. The CLI creates `$HOME/.ukiyo` as 0700 and credentials, known hosts and temporary SSH keys as 0600. It rejects unsafe ownership, permissions and symlinks. Do not pre-create `.ukiyo` as 0755 or use `sudo` for signup.

## Commands (all platforms)

Before creating an account, review the approved Terms at https://u-kiyo.ai/terms/
and Privacy at https://u-kiyo.ai/privacy/. `GET https://pay.u-kiyo.ai/api/v1/terms`
provides the current Terms version, URL and SHA-256. After explicit authorization
to agree, use `ukiyo signup --accept-terms 2026-10-10 --json` for the current
approved version. The CLI fetches current metadata, rejects a changed version,
and sends explicit acceptance and the document hash to the existing backend.
This is a one-time signup agreement, not approval per rental. No browser login,
Telegram or stdin is required. Do not auto-accept a future version.

Legacy servers that do not require consent continue to support `ukiyo signup
--json`. A `TERMS_ACCEPTANCE_REQUIRED` error creates no credential; review the
current document and retry with its explicitly approved version. Existing
credentials must never be overwritten or replaced with another signup.

```text
ukiyo signup --accept-terms 2026-10-10 --json
ukiyo balance --json
ukiyo topup link --amount 5 --json
ukiyo offers --gpu RTX4090 --count 1 --json
ukiyo rent --gpu RTX4090 --count 1 --budget 5 --idempotency-key <stable-key> --wait --timeout 600 --json
ukiyo exec <deployment-id> --json -- nvidia-smi
ukiyo terminate <deployment-id> --yes --wait --json
```

Funding is one payer handoff, not browser authentication or approval per rental. Preserve the same idempotency key and intent when retrying. A wait timeout preserves resource identity: inspect it rather than creating another rental. `exec` materializes the SSH key only in private local storage and deletes it afterward. Never print credentials or private keys.

CLI 0.2.5 checks `GET /api/v1/me` billing capability when `--budget` is omitted.
Only eligible `ACCOUNT_BALANCE` accounts with `budgetRequired: false` can use:

```text
ukiyo rent --gpu rtx-4090 --count 1 --idempotency-key <stable-key> --wait --json
```

Legacy `LEGACY_PREPAID` accounts still require `--budget` (minimum $5).
For account-balance rentals, an optional budget is an additional spend ceiling,
not purchased hours. Duration/expiry fields are null; unused account credits
remain available after actual usage settles. Existing account/key limits apply.

Canonical command reference: https://docs.u-kiyo.ai/connect/cli
