#!/bin/sh
# Install the feishu-bridge dsh profile (~/.dsh/profiles/feishu-bridge): render
# the templates below profile/ when absent and link the plugin in as a
# workspace package.
#
# cordis.patch.yml is deliberately NEVER written here: it is the profile's
# self-evolution layer, live-edited under Cordis HMR — copying a template
# over it would roll that evolution back. package.json and
# pnpm-workspace.yaml are likewise only rendered when missing.
set -eu

PKG_DIR=$(cd "$(dirname "$0")" && pwd)
FORK_DIR=${FORK_DIR:-$(cd "$PKG_DIR/../../.." && pwd)}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR=$DSH_HOME/profiles/feishu-bridge

mkdir -p "$PROFILE_DIR"

for f in package.json cordis.patch.yml pnpm-workspace.yaml; do
  if [ -f "$PROFILE_DIR/$f" ]; then
    echo "note: $PROFILE_DIR/$f exists, left untouched (self-evolved)"
  else
    sed "s|@FORK_DIR@|$FORK_DIR|g" "$PKG_DIR/profile/$f" > "$PROFILE_DIR/$f"
    echo "wrote $PROFILE_DIR/$f"
  fi
done

(cd "$PROFILE_DIR" && pnpm install)

echo "profile installed at $PROFILE_DIR"
