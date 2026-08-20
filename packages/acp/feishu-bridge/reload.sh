#!/bin/sh
# Make harness TS changes take effect on the feishu-bridge daemon: rebuild the
# host face, then bounce the launchd daemon. Unlike cc-connect-bridge's
# reload.sh there is no per-session respawn to lean on — engines and the Feishu
# WS platform all live in the daemon process, so the daemon itself restarts and
# sessions resume from the jsonl log on their next message.
#
#   --skip-build   restart only (build already done elsewhere)
#
# Refuses to run from inside the daemon (e.g. an agent session it hosts): the
# restart would kill the script's own process tree before `launchctl load`.
# Mid-turn sessions lose the current turn (transcript rolls back to the last
# complete turn; resend to retry) — run when sessions are idle.
#
# macOS launchd only; Linux uses `systemctl --user restart feishu-bridge`
# (OPERATIONS.md §5).
set -eu

PKG_DIR=$(cd "$(dirname "$0")" && pwd)
FORK_DIR=${FORK_DIR:-$(cd "$PKG_DIR/../../.." && pwd)}
PLIST=${PLIST:-"$HOME/Library/LaunchAgents/com.dsh.feishu-bridge.plist"}
LOG_DIR=${LOG_DIR:-"$HOME/.dsh"}
LABEL=$(basename "$PLIST" .plist)
PROFILE=${PROFILE:-feishu-bridge}

BUILD=1
case "${1:-}" in
  "") ;;
  --skip-build) BUILD=0 ;;
  *) echo "usage: $0 [--skip-build]" >&2; exit 1 ;;
esac

[ "$(uname)" = Darwin ] || { echo "error: launchd is macOS-only; on Linux use: systemctl --user restart feishu-bridge" >&2; exit 1; }
[ -f "$PLIST" ] || { echo "error: plist not found: $PLIST" >&2; exit 1; }

# Walk the ppid chain and refuse when an ancestor is the daemon itself.
p=$$
while [ "$p" -gt 1 ]; do
  p=$(ps -o ppid= -p "$p" | tr -d ' ') || break
  case "$p" in ''|*[!0-9]*) break ;; esac
  if ps -o command= -p "$p" | grep -q "bin\.js --profile $PROFILE"; then
    echo "error: this shell runs inside the $LABEL daemon (pid $p); restarting it would abort this turn. Run from a plain terminal." >&2
    exit 1
  fi
done

if [ "$BUILD" -eq 1 ]; then
  echo "==> building host-face libs in $FORK_DIR"
  (cd "$FORK_DIR" && pnpm run build:lib:host)
  for f in "$FORK_DIR/apps/cli/lib/bin.js" "$PKG_DIR/lib/index.js"; do
    [ -f "$f" ] && echo "    built: $f ($(date -r "$f" '+%Y-%m-%d %H:%M:%S'))"
  done
fi

echo "==> restarting daemon $LABEL"
launchctl unload "$PLIST"
i=0
while pgrep -f "bin\.js --profile $PROFILE" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 20 ] && { echo "error: old daemon still running after 10s; aborting before load" >&2; exit 1; }
  sleep 0.5
done

stamp=$(date '+%Y%m%d%H%M')
for log in stdout stderr; do
  [ -f "$LOG_DIR/feishu-bridge-$log.log" ] && mv "$LOG_DIR/feishu-bridge-$log.log" "$LOG_DIR/feishu-bridge-$log.log.old-$stamp"
done

launchctl load "$PLIST"
sleep 2
launchctl list | grep -q "^[-0-9]*.*[[:space:]]$LABEL\$" || { echo "error: daemon not in launchctl list after load" >&2; exit 1; }

echo "==> waiting for Feishu WS connection"
STDOUT="$LOG_DIR/feishu-bridge-stdout.log"
i=0
while ! grep -q 'ws client ready' "$STDOUT" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "error: no 'ws client ready' in $STDOUT after 30s; recent stderr:" >&2
    tail -5 "$LOG_DIR/feishu-bridge-stderr.log" >&2 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done
echo "==> ok: daemon restarted on latest build, Feishu WS ready (logs rotated to .old-$stamp)"
