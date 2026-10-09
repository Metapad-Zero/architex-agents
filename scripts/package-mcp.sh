#!/usr/bin/env bash
# Keep this allowlist aligned with the MCP runtime's local imports. Never archive the checkout.
set -euo pipefail
export LC_ALL=C TZ=UTC
umask 022

repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
bundle_name=architex-agents-mcp
staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/architex-mcp.XXXXXX")
archive_tmp=''
cleanup() {
  rm -rf "$staging_dir"
  if [[ -n "$archive_tmp" ]]; then rm -f "$archive_tmp"; fi
}
trap cleanup EXIT

files=(
  LICENSE
  docs/agents/JIT-INTERFACE-SPEC.md
  mcp-server/README.md
  mcp-server/bun.lock
  mcp-server/package.json
  mcp-server/src/agentWallet.ts
  mcp-server/src/chain.ts
  mcp-server/src/gate.ts
  mcp-server/src/index.ts
  mcp-server/src/jit.ts
  mcp-server/src/tools.ts
  mcp-server/tsconfig.json
  server/x402/errors.ts
  server/x402/money.ts
  src/deployments/arc-mainnet.json
  src/deployments/arc-mainnet-jit.json
  src/deployments/arc-testnet.json
  src/lib/abi.ts
  src/lib/jit.ts
  src/lib/jitAbi.ts
  jit/lib/v4-core/licenses/MIT_LICENSE
  src/lib/curve.ts
  src/lib/rpcLogs.ts
)

for file in "${files[@]}"; do
  if [[ ! -f "$repo_dir/$file" || -L "$repo_dir/$file" ]]; then
    printf 'Missing or symlinked MCP source: %s\n' "$file" >&2
    exit 1
  fi
  destination="$staging_dir/$bundle_name/$file"
  mkdir -p "$(dirname "$destination")"
  cp "$repo_dir/$file" "$destination"
  chmod 0644 "$destination"
  touch -t 202001010000 "$destination"
  printf '%s/%s\n' "$bundle_name" "$file" >> "$staging_dir/files"
done

# Shared imports live outside mcp-server, so install its exact dependency set at the bundle root.
bun -e '
  const manifest = await Bun.file(process.argv[1]).json();
  manifest.scripts = {
    start: "bun --no-install run mcp-server/src/index.ts",
    typecheck: "tsc --noEmit --project mcp-server/tsconfig.json",
  };
  await Bun.write(process.argv[2], JSON.stringify(manifest, null, 2) + "\n");
' "$staging_dir/$bundle_name/mcp-server/package.json" "$staging_dir/$bundle_name/package.json"
cp "$staging_dir/$bundle_name/mcp-server/bun.lock" "$staging_dir/$bundle_name/bun.lock"
for file in package.json bun.lock; do
  chmod 0644 "$staging_dir/$bundle_name/$file"
  touch -t 202001010000 "$staging_dir/$bundle_name/$file"
  printf '%s/%s\n' "$bundle_name" "$file" >> "$staging_dir/files"
done
sort -o "$staging_dir/files" "$staging_dir/files"

case "$(/usr/bin/tar --version)" in
  *bsdtar*) ownership=(--uid 0 --gid 0 --uname root --gname root --no-fflags --no-mac-metadata) ;;
  *'GNU tar'*) ownership=(--owner=0 --group=0) ;;
  *) printf 'MCP packaging requires system GNU tar or bsdtar.\n' >&2; exit 1 ;;
esac

# Exact file paths prevent recursive inclusion; ustar and gzip -n avoid host metadata.
COPYFILE_DISABLE=1 /usr/bin/tar -c --format=ustar --no-recursion --no-acls --no-xattrs \
  "${ownership[@]}" -f "$staging_dir/source.tar" -C "$staging_dir" -T "$staging_dir/files"
/usr/bin/gzip -n -9 < "$staging_dir/source.tar" > "$staging_dir/source.tar.gz"
/usr/bin/tar -tzf "$staging_dir/source.tar.gz" > "$staging_dir/entries"
bun -e '
  if (await Bun.file(process.argv[1]).text() !== await Bun.file(process.argv[2]).text()) {
    console.error("The MCP archive entries differ from the source allowlist.");
    process.exit(1);
  }
' "$staging_dir/files" "$staging_dir/entries"

mkdir -p "$repo_dir/public/downloads"
archive_tmp=$(mktemp "$repo_dir/public/downloads/.architex-mcp.XXXXXX")
cp "$staging_dir/source.tar.gz" "$archive_tmp"
chmod 0644 "$archive_tmp"
mv "$archive_tmp" "$repo_dir/public/downloads/$bundle_name.tar.gz"
archive_tmp=''
printf 'Packaged public/downloads/%s.tar.gz (%s source and install files).\n' "$bundle_name" "$(( ${#files[@]} + 2 ))"
