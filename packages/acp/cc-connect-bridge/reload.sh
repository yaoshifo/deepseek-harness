#!/bin/sh
# Make harness TS changes take effect on the cc-connect dsh backend, without
# restarting cc-connect.
#
#   profile cordis.patch.yml / CLAUDE.md / skills  -> already live (Cordis HMR
#                                                    + file watchers), not our job
#   harness TS source (bridge/tools/apps/cli)     -> rebuilt here; live dsh
#                                                    processes are SIGTERM'd so the
#                                                    engine respawns each one on its
#                                                    next message (same session id,
#                                                    resume keeps the transcript)
#   cc-connect Go code                            -> untouched; still needs a manual
#                                                    ./build_to_restart.sh by the user
#
# Caveat: a session that is mid-turn when recycled loses that turn (transcript
# rolls back to the last complete turn; resend to retry). Run when sessions are
# idle, or pass --no-recycle to build only.
set -eu

PKG_DIR=$(cd "$(dirname "$0")" && pwd)
FORK_DIR=${FORK_DIR:-$(cd "$PKG_DIR/../../.." && pwd)}
RECYCLE=1
case "${1:-}" in
  "") ;;
  --no-recycle) RECYCLE=0 ;;
  *) echo "usage: $0 [--no-recycle]" >&2; exit 1 ;;
esac

echo "==> building host-face libs in $FORK_DIR"
(cd "$FORK_DIR" && pnpm run build:lib:host)

for f in "$FORK_DIR/apps/cli/lib/bin.js" "$PKG_DIR/lib/index.js"; do
  if [ -f "$f" ]; then
    echo "    built: $f ($(date -r "$f" '+%Y-%m-%d %H:%M:%S'))"
  else
    echo "    warning: expected build output missing: $f" >&2
  fi
done

if [ "$RECYCLE" -eq 0 ]; then
  echo "==> --no-recycle: live dsh processes left alone"
  exit 0
fi

PAT='apps/cli/lib/bin\.js --profile cc-connect'

# Running this from inside a dsh session (e.g. an agent self-modifying the
# harness) must not kill the caller's own runtime mid-turn: walk /proc ancestry
# and exclude the dsh process this script descends from. From a plain terminal
# there is no such ancestor and nothing is excluded.
OWN=$(p=$$; while [ "$p" -gt 1 ]; do
  p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null) || break
  case "$p" in ''|*[!0-9]*) break ;; esac
  if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q "$PAT"; then
    echo "$p"; break
  fi
done)

# Live cc-connect dsh processes, minus the caller's own.
list_pids()
{
  pgrep -f "$PAT" 2>/dev/null | grep -vx "${OWN:-0}" || true
}

[ -n "$OWN" ] && echo "    skipping caller's own dsh process: $OWN"
PIDS=$(list_pids)
if [ -z "$PIDS" ]; then
  echo "==> no live dsh (cc-connect) processes to recycle"
  exit 0
fi

echo "==> recycling dsh sessions (SIGTERM): $(echo $PIDS)"
kill $PIDS 2>/dev/null || true
i=0
while [ $i -lt 25 ] && [ -n "$(list_pids)" ]; do
  sleep 0.2
  i=$((i + 1))
done
LEFT=$(list_pids)
if [ -n "$LEFT" ]; then
  echo "    SIGKILL stragglers: $(echo $LEFT)"
  kill -9 $LEFT 2>/dev/null || true
fi

cat <<'EOF'
Done. Each session transparently respawns with the new libs on its next
message (same session id, transcript resumed). cc-connect itself was NOT
restarted — Go-side changes still need a manual ./build_to_restart.sh.
EOF
