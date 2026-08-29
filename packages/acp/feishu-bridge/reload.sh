#!/bin/sh
# Make harness TS changes take effect on the feishu-bridge daemon: rebuild the
# host face, then restart the daemon under its supervisor — launchd
# (unload/load) on macOS, `systemctl --user restart` on Linux. Engines and the
# Feishu WS platform all live in the daemon process, so the daemon itself
# restarts and sessions resume from the jsonl log on their next message. The
# restart is also this deployment's config-apply gate: profile yml edits take
# effect here (config HMR is off; see the bundle's cordis.patch.yml), and a
# broken file aborts the preflight below before anything is stopped.
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
# If the WS-ready probe times out, the script prints a rollback runbook from
# the git state captured before the restart. Nothing rolls back automatically:
# in single-tree dogfood this clone is the live workspace of concurrent agent
# sessions, so git mutations are printed for a human in a plain terminal.
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

# Best-effort rollback state, captured before anything stops: the WS-ready
# probe prints it as a runbook when the restarted daemon never comes up. With
# --skip-build the captured HEAD may already be past the code that was
# actually built; the runbook is still the right first move.
ROLLBACK_SHA=$(git -C "$FORK_DIR" rev-parse HEAD 2>/dev/null || true)
ROLLBACK_DIRTY=false
if [ -n "$(git -C "$FORK_DIR" status --porcelain 2>/dev/null | head -n 1)" ]; then
  ROLLBACK_DIRTY=true
fi

# Printed when the WS-ready probe times out: the new build cannot boot and
# the supervisor (launchd KeepAlive / systemd Restart) keeps crash-looping it
# until the tree is rolled back. Executed by a human, never by this script.
print_rollback_hint() {
  if [ -z "$ROLLBACK_SHA" ]; then
    echo "error: the restarted daemon never reached 'ws client ready'; the supervisor will keep crash-looping this build. Git state unavailable in $FORK_DIR — manually check out the last running commit, rebuild (CI=true pnpm run build:lib), and rerun $PKG_DIR/reload.sh --skip-build" >&2
    return 0
  fi
  echo "error: the restarted daemon never reached 'ws client ready'; the supervisor will keep crash-looping this build. Roll back to the pre-reload tree:" >&2
  echo "  cd $FORK_DIR" >&2
  if [ "$ROLLBACK_DIRTY" = true ]; then
    echo "  git stash push -m 'fb-reload-rollback $(date '+%Y%m%d%H%M')'   # the dirty tree shipped in the broken build" >&2
  fi
  echo "  git checkout $ROLLBACK_SHA" >&2
  echo "  CI=true pnpm run build:lib" >&2
  echo "  $PKG_DIR/reload.sh --skip-build   # restarts and re-probes WS readiness" >&2
}

if [ "$BUILD" -eq 1 ]; then
  echo "==> building host+client face libs in $FORK_DIR"
  # CI=true: pnpm's pre-run deps check auto-installs when the lockfile moved
  # (e.g. after a pull); without it the modules-dir purge prompt aborts in
  # this TTY-less script and /reload fails before the daemon restart.
  # NODE_OPTIONS: the default V8 heap (~2GiB on this 7.5GiB box) OOMs tsc -b
  # with exit 134 once the workspace graph grows past a big merge (2026-08-24);
  # 6144 is the ceiling proven here (same value the pre-push/typecheck
  # workaround uses). ${NODE_OPTIONS:-…} keeps a manual run's own setting.
  # build:lib (both faces), never host-only: face-split packages whose
  # tsdown config uses clientBundle (dsh-typert-registry, dsh-api-gateway)
  # emit their runtime JS only in the client face — a host-only build boots
  # the daemon into a loader-import crash loop (2026-08-29 dev incident).
  (cd "$FORK_DIR" && CI=true NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}" pnpm run build:lib)
  for f in "$FORK_DIR/apps/cli/lib/bin.js" "$PKG_DIR/lib/index.js"; do
    [ -f "$f" ] && echo "    built: $f ($(date -r "$f" '+%Y-%m-%d %H:%M:%S'))"
  done
fi

# Config preflight before any stop/restart: compose the profile's patch layers
# with the same loader the restart will boot (--dump-config parses without
# booting, so no second process ever connects to Feishu). A broken
# cordis.patch.yml aborts while the old daemon still runs — it keeps its
# last-good tree, the group gets the /reload failure reply, and no systemd
# crash-loop starts. Limit: dump mode evaluates no !!js and checks no plugin
# schemas; those errors still surface only after the restart. The cordis.yml
# root rewrite inside --dump-config is inert because this bundle disables the
# hmr row (no module watcher on the profile dir) and the preflight never
# touches the patch ymls the launcher's config watchers track.
echo "==> validating profile config ($PROFILE)"
CHECK_ERR="$LOG_DIR/feishu-bridge-config-check.err"
if ! node "$FORK_DIR/apps/cli/lib/bin.js" --profile "$PROFILE" --dump-config >/dev/null 2>"$CHECK_ERR"; then
  echo "error: profile config failed validation; daemon left running on the current config:" >&2
  tail -5 "$CHECK_ERR" >&2 2>/dev/null || true
  exit 1
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
      print_rollback_hint
      exit 1
    fi
    sleep 0.5
  done
  # Stability re-check: a boot that dies right after emitting 'ws client
  # ready' passed the probe above while launchd KeepAlive crash-looped it —
  # the 2026-08-29 dev reload reported success on a daemon that died the
  # same second. launchctl list shows the label's current PID ("-" while
  # between respawns), so a respawn inside the settling window changes it.
  daemon_pid() { launchctl list | grep "[[:space:]]$LABEL\$" | cut -f1; }
  pid=$(daemon_pid)
  sleep "${FB_RELOAD_STABILITY_SECS:-5}"
  if [ -z "$pid" ] || [ "$pid" = "-" ] || [ "$(daemon_pid)" != "$pid" ]; then
    echo "error: daemon exited within the stability window after 'ws client ready'; recent stderr:" >&2
    tail -5 "$LOG_DIR/feishu-bridge-stderr.log" >&2 2>/dev/null || true
    print_rollback_hint
    exit 1
  fi
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
      print_rollback_hint
      exit 1
    fi
    sleep 0.5
  done
  # Stability re-check (same rationale as the launchd branch): the MainPID
  # that just connected must still be the active one after a settling
  # window — systemd rewrites MainPID on every auto-restart, so a
  # crash-looping boot can never satisfy it.
  pid=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
  sleep "${FB_RELOAD_STABILITY_SECS:-5}"
  if [ -z "$pid" ] || [ "$pid" = 0 ] \
     || ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null \
     || [ "$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)" != "$pid" ]; then
    echo "error: daemon exited within the stability window after 'ws client ready'; recent journal:" >&2
    journalctl --user -u "$UNIT" -n 5 2>/dev/null >&2 || true
    print_rollback_hint
    exit 1
  fi
  echo "==> ok: daemon $UNIT restarted on latest build, Feishu WS ready"
fi
