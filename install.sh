#!/bin/sh
# Pinned CLI installer. Does not create credentials or contact the rental API.
set -eu
version='0.2.5'
expected='__CLI_SHA256__'
command -v node >/dev/null || { echo 'Node.js 22 or newer is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node.js 22 or newer is required.' >&2; exit 1; }
command -v ssh >/dev/null || { echo 'OpenSSH client is required.' >&2; exit 1; }
directory="$HOME/.local/share/ukiyo"
bin="$HOME/.local/bin"
mkdir -p "$directory" "$bin"
pending=$(mktemp "$directory/.download.XXXXXX")
trap 'rm -f "$pending"' EXIT HUP INT TERM
curl -fSL "https://u-kiyo.ai/releases/cli/$version/ukiyo-cli-$version.mjs" -o "$pending"
node -e 'const fs=require("node:fs"),crypto=require("node:crypto");if(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")!==process.argv[2]){console.error("CLI checksum mismatch. Installation stopped.");process.exit(1)}' "$pending" "$expected"
mv "$pending" "$directory/ukiyo-cli-$version.mjs"
printf '%s\n' '#!/bin/sh' 'exec node "$HOME/.local/share/ukiyo/ukiyo-cli-0.2.5.mjs" "$@"' > "$bin/ukiyo"
chmod 755 "$bin/ukiyo"
"$bin/ukiyo" --version
echo 'Installed. Add $HOME/.local/bin to PATH. Before signup, review https://u-kiyo.ai/terms/ and run: ukiyo signup --help'
