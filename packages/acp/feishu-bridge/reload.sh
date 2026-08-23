#!/bin/sh
# Make harness TS changes take effect on the feishu-bridge daemon: rebuild the
# host face, then restart the daemon under its supervisor — launchd
# (unload/load) on macOS, `systemctl --user restart` on Linux. Engines and the
# Feishu WS platform all live in the daemon process, so the daemon itself
# restarts and sessions resume from the jsonl log on their next message.
#
#   --skip-build   restart only (build already done elsewhere)
#
# Refuses to run from inside the daemon (e.g. an agent session it hosts): the
# restart would kill the script's own process tree before the restart lands.
# The daemon's own /reload command is the sanctioned exception: it spawns this
# script detached with FB_RELOAD_FROM_DAEMON=1, which skips only the
# ppid-walk guard — the detached process outlives the daemon teardown. On
# Linux that spawn goes through `systemd-run --user --scope`: setsid alone
# keeps the child in the daemon unit's cgroup, which the restart's
# control-group kill sweeps away mid-restart (2026-08-22); the scope unit is
# a sibling and survives.
# On macOS, if the script still dies between unload and load, a trap re-loads
# the service so the bot is never left stranded offline; the Linux restart is
# one atomic systemctl operation with no such window. Mid-turn sessions lose
# the current turn (transcript rolls back to the last complete turn; resend
# to retry) — run when sessions are idle.
set -eu

PKG_DIR=$(cd "$(dirname "$0")" && pwd)
FORK_DIR=${FORK_DIR:-$(cd "$PKG_DIR/../../.." && pwd)}
PLIST=${PLIST:-"$HOME/Library/LaunchAgents/com.dsh.feishu-bridge.plist"}
LOG_DIR=${LOG_DIR:-"$HOME/.dsh"}
LABEL=$(basename "$PLIST" .plist)
PROFILE=${PROFILE:-feishu-bridge}
UNIT=${UNIT:-feishu-bridge}

BUILD=1
case "${1:-}" in
  "") ;;
  --skip-build) BUILD=0 ;;
  *) echo "usage: $0 [--skip-build]" >&2; exit 1 ;;
esac

OS=$(uname)

# Refuse to run from inside the daemon (e.g. an agent session it hosts): the
# restart would kill the script's own process tree before `launchctl load`.
# Primary signal: dsh exports DSH_SESSION_JSONL into every bash-tool execution
# and the daemon's sessions live under the feishu-bridge store, so the path
# names the hosting daemon. XPC_SERVICE_NAME cannot serve here — the bash-tool
# sandbox rewrites the child's copy to a literal 0 — and the ppid walk below
# dies on its first hop because the sandbox denies ps (both verified in the
# 2026-08-20 outage, which this guard now prevents). The walk stays as the
# fallback for a manually started daemon outside any dsh session.
case "${DSH_SESSION_JSONL:-}" in
  "${DSH_HOME:-$HOME/.dsh}/feishu-bridge-sessions/"*)
    echo "error: this shell runs inside the $LABEL daemon (session store ${DSH_SESSION_JSONL}); restarting it would abort this turn. Run from a plain terminal." >&2
    exit 1
    ;;
esac
# FB_RELOAD_FROM_DAEMON=1 skips only the ppid walk: the daemon's own /reload
# command spawns this script detached (setsid), so the walk would always see
# the live daemon as an ancestor and false-positive — while the detached spawn
# is exactly the safe case the walk approximates. The DSH_SESSION_JSONL guard
# above still refuses daemon-hosted sessions, so an agent cannot use this
# variable to bypass it.
if [ "${FB_RELOAD_FROM_DAEMON:-}" != 1 ]; then
  p=$$
  while [ "$p" -gt 1 ]; do
    p=$(ps -o ppid= -p "$p" | tr -d ' ') || break
    case "$p" in ''|*[!0-9]*) break ;; esac
    if ps -o command= -p "$p" | grep -q "bin\.js --profile $PROFILE"; then
      echo "error: this shell runs inside the $LABEL daemon (pid $p); restarting it would abort this turn. Run from a plain terminal." >&2
      exit 1
    fi
  done
fi

# Platform precheck after the guards: a refusal must not touch the system.
# The unit check mirrors the plist check (fail loud before the build burns
# minutes on a deployment that cannot restart).
if [ "$OS" = Darwin ]; then
  [ -f "$PLIST" ] || { echo "error: plist not found: $PLIST" >&2; exit 1; }
else
  systemctl --user cat "$UNIT" >/dev/null 2>&1 || { echo "error: systemd unit not found: $UNIT" >&2; exit 1; }
fi

if [ "$BUILD" -eq 1 ]; then
  echo "==> building host-face libs in $FORK_DIR"
  (cd "$FORK_DIR" && pnpm run build:lib:host)
  for f in "$FORK_DIR/apps/cli/lib/bin.js" "$PKG_DIR/lib/index.js"; do
    [ -f "$f" ] && echo "    built: $f ($(date -r "$f" '+%Y-%m-%d %H:%M:%S'))"
  done
fi

if [ "$OS" = Darwin ]; then
  echo "==> restarting daemon $LABEL"
  launchctl unload "$PLIST"
  # Between unload and load, any exit must put the service back: an abort or the
  # daemon teardown killing this script's own tree once stranded the bot offline
  # (2026-08-20). EXIT covers abort paths; TERM/INT cover teardown kills. The
  # load retries because launchctl load right after unload can fail with an
  # Input/output error while launchd still settles the removal. SIGKILL cannot
  # be caught and stays a residual risk.
  restore() {
    i=0
    while [ "$i" -lt 10 ]; do
      launchctl load "$PLIST" 2>/dev/null && return 0
      i=$((i + 1))
      sleep 0.5
    done
    echo "error: could not re-load $LABEL; run manually: launchctl load $PLIST" >&2
    return 0
  }
  trap restore EXIT
  trap 'restore; trap - EXIT; exit 143' TERM
  trap 'restore; trap - EXIT; exit 130' INT
  i=0
  while pgrep -f "bin\.js --profile $PROFILE" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 20 ] && { echo "error: old daemon still running after 10s; service re-loaded, retry from a plain terminal" >&2; exit 1; }
    sleep 0.5
  done

  stamp=$(date '+%Y%m%d%H%M')
  for log in stdout stderr; do
    [ -f "$LOG_DIR/feishu-bridge-$log.log" ] && mv "$LOG_DIR/feishu-bridge-$log.log" "$LOG_DIR/feishu-bridge-$log.log.old-$stamp"
  done

  launchctl load "$PLIST"
  trap - EXIT TERM INT
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
else
  echo "==> restarting daemon $UNIT (systemd)"
  systemctl --user restart "$UNIT"

  echo "==> waiting for Feishu WS connection"
  # The stamp is taken after restart returns: the old daemon is already stopped
  # then, so a WS-reconnect line it emitted just before teardown cannot satisfy
  # the probe. Unit stdout/stderr go to the journal (no log rotation here).
  stamp=$(date '+%Y-%m-%d %H:%M:%S')
  i=0
  while ! journalctl --user -u "$UNIT" --since "$stamp" 2>/dev/null | grep -q 'ws client ready'; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "error: no 'ws client ready' for $UNIT since restart; recent journal:" >&2
      journalctl --user -u "$UNIT" -n 5 2>/dev/null >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  echo "==> ok: daemon $UNIT restarted on latest build, Feishu WS ready"
fi
