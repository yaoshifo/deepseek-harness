#!/bin/sh
# Install the cc-connect dsh profile (~/.dsh/profiles/cc-connect): render the
# templates below profile/ when absent, link the bridge in as a workspace
# package, and symlink the Claude Code global instructions for reuse.
#
# cordis.patch.yml is deliberately NEVER written here: it is the profile's
# self-evolution layer, live-edited by agents under Cordis HMR — copying a
# template over it would roll that evolution back. package.json and
# pnpm-workspace.yaml are likewise only rendered when missing; existing files
# (possibly self-evolved with extra link: deps) are left untouched.
set -eu

PKG_DIR=$(cd "$(dirname "$0")" && pwd)
FORK_DIR=${FORK_DIR:-$(cd "$PKG_DIR/../../.." && pwd)}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR=$DSH_HOME/profiles/cc-connect
SESSION_ROOT=$DSH_HOME/cc-connect-sessions

mkdir -p "$PROFILE_DIR" "$SESSION_ROOT"

for f in package.json pnpm-workspace.yaml; do
  if [ -f "$PROFILE_DIR/$f" ]; then
    echo "note: $PROFILE_DIR/$f exists, left untouched (self-evolved)"
  else
    sed "s|@FORK_DIR@|$FORK_DIR|g" "$PKG_DIR/profile/$f" > "$PROFILE_DIR/$f"
    echo "wrote $PROFILE_DIR/$f"
  fi
done

(cd "$PROFILE_DIR" && pnpm install)

if [ -f "$HOME/.claude/CLAUDE.md" ]; then
  ln -sfn "$HOME/.claude/CLAUDE.md" "$DSH_HOME/AGENTS.md"
  echo "linked $DSH_HOME/AGENTS.md -> ~/.claude/CLAUDE.md"
else
  echo "note: ~/.claude/CLAUDE.md not found, skipped global instructions symlink"
fi

echo "profile installed at $PROFILE_DIR"
