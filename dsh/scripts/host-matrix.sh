#!/usr/bin/env bash
# Run scripts/host-check.mjs against each published DSH version in turn.
#
# The unit tests hand the plugin a Session they wrote themselves, so they stay
# green when DSH renames what the plugin reads (0.1.2 dropped `session.events`,
# 0.1.7 replaced the tool-result block). This installs what `npm pack` would ship
# next to each real DSH and judges one turn by what a stub EverOS received.
# No credentials, no LLM, no EverOS.
#
#   ./scripts/host-matrix.sh                     # the supported versions below
#   ./scripts/host-matrix.sh 0.2.2-rc.2 ...      # specific @deepseek-ai/dsh-agent versions
set -uo pipefail

VERSIONS=("$@")
[ ${#VERSIONS[@]} -eq 0 ] && VERSIONS=(
  0.1.0-rc.6 0.1.2-rc.1 0.1.5-rc.3 0.1.7-rc.2
  0.2.0-rc.2 0.2.1-rc.3 0.2.1-rc.5 0.2.2-rc.1 0.2.2-rc.2
)
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# A template with XXXXXX: GNU mktemp rejects macOS-style `-t prefix`.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-host-matrix.XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT INT TERM

TARBALL="$(cd "$PKG" && npm pack --silent --pack-destination "$WORK" | tail -1)"
FAIL=0
for v in "${VERSIONS[@]}"; do
  dir="$WORK/dsh-$v"
  mkdir -p "$dir"
  echo '{"name":"host-check","private":true,"type":"module"}' >"$dir/package.json"
  # Only the agent is pinned: npm resolves its llm/session peers the way a user's
  # install would (0.1.0-rc.6 pulls 0.1.0-rc.8 of both).
  if ! (cd "$dir" && npm install --no-audit --no-fund \
      "@deepseek-ai/dsh-agent@$v" @deepseek-ai/schemastery) >"$dir/npm.log" 2>&1; then
    printf 'FAIL %-12s npm install failed:\n' "$v"; tail -5 "$dir/npm.log"; FAIL=1; continue
  fi
  # Extract rather than `npm install` the tarball: its peer range is what is under test.
  # After the install, which would prune a directory it did not create.
  mkdir -p "$dir/node_modules/@everos-ai/dsh-plugin"
  tar xzf "$WORK/$TARBALL" -C "$dir/node_modules/@everos-ai/dsh-plugin" --strip-components=1
  cp "$PKG/scripts/host-check.mjs" "$dir/"
  printf '%-12s ' "$v"
  (cd "$dir" && node host-check.mjs) || FAIL=1
done
exit $FAIL
