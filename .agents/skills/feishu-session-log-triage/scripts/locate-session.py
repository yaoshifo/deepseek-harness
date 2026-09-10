#!/usr/bin/env python3
"""Locate DSH session data and session logs for a Feishu chat id.

Scans every bot's sessions.json under <dsh-home>/feishu-bridge/, resolves the
s-id -> agentSessionID mapping, and prints each session.jsonl.zstd path.
Session keys are `<project>:<chat_id>` (group chats) or
`<project>:<chat_id>:<ou_user>` (single chats), where <project> is the bridge
project name (feishu, vault, op-dev, ...); keys are matched by the chat id
appearing as a complete `:`-delimited segment, never by a hardcoded prefix,
so single-chat keys match despite their trailing user segment. Also reports
spawn-group registration (sessions/<bot>_spawned.json) and workspace
directory overrides that mention the chat.

Usage:
  python3 locate-session.py <oc_chat_id> [--dsh-home <dir>]

Exit 0 when at least one session entry is found, 1 otherwise.
"""

import argparse
import glob
import json
import os
import sys


def scan_logs(dsh_home, agent_session_id):
    """Return every session log path whose directory matches the session id."""
    roots = os.path.join(dsh_home, "feishu-bridge-sessions", "*")
    hits = []
    for workspace in sorted(glob.glob(roots)):
        # Log file names carry the session format version (session.jsonl.zstd,
        # session.v2.jsonl.zstd, ...); match any version rather than one name.
        for candidate in sorted(
            glob.glob(os.path.join(workspace, agent_session_id, "session*.jsonl.zstd"))
        ):
            hits.append(candidate)
    return hits


def has_chat_segment(key, chat_id):
    """True when chat_id appears as a complete `:`-delimited segment of key."""
    return chat_id in key.split(":")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("chat_id", help="Feishu chat id, e.g. oc_9e68bd6a...")
    parser.add_argument("--dsh-home", default=os.path.expanduser("~/.dsh"))
    args = parser.parse_args()
    # Session keys are `<project>:<chat_id>` (groups) or
    # `<project>:<chat_id>:<ou_user>` (single chats); the project segment
    # varies per bridge deployment, so match the chat id as a complete
    # `:`-delimited segment instead of assuming a prefix.
    suffix = ":" + args.chat_id

    session_files = sorted(
        glob.glob(os.path.join(args.dsh_home, "feishu-bridge", "*", "sessions.json"))
    )
    if not session_files:
        print(f"no sessions.json under {args.dsh_home}/feishu-bridge/*/", file=sys.stderr)
        return 1

    found_any = False
    for sessions_file in session_files:
        bot = os.path.basename(os.path.dirname(sessions_file))
        with open(sessions_file, encoding="utf-8") as handle:
            data = json.load(handle)

        active_by_key = {
            key: sid
            for key, sid in (data.get("activeSession") or {}).items()
            if isinstance(key, str) and has_chat_segment(key, args.chat_id)
        }
        user_sessions_by_key = {
            key: sids
            for key, sids in (data.get("userSessions") or {}).items()
            if isinstance(key, str) and has_chat_segment(key, args.chat_id)
        }
        matched_keys = sorted(
            set(active_by_key) | set(user_sessions_by_key),
            key=lambda k: (k != "feishu" + suffix, k),
        )
        sessions = data.get("sessions", {})
        # Sessions spawned FROM this chat record the chat as their parent key.
        children = [
            sid
            for sid, entry in sessions.items()
            if isinstance(entry, dict)
            and has_chat_segment(str(entry.get("parentSessionKey", "")), args.chat_id)
        ]
        if not matched_keys and not children:
            continue
        found_any = True

        print(f"== bot: {bot}  ({sessions_file})")
        for key in matched_keys:
            active = active_by_key.get(key)
            user_sessions = user_sessions_by_key.get(key) or []
            owned = list(dict.fromkeys(
                ([active] if active else []) + list(user_sessions)
            ))
            print(f"   key: {key}")
            print(f"   activeSession -> {active}")
            print(f"   userSessions  -> {user_sessions}")
            meta = data.get("userMeta", {}).get(key)
            if meta:
                print(f"   userMeta      -> userName={meta.get('userName')!r} chatName={meta.get('chatName')!r}")
            for sid in owned:
                entry = sessions.get(sid)
                if not isinstance(entry, dict):
                    print(f"   {sid}  (no session record)")
                    continue
                agent_id = entry.get("agentSessionID", "?")
                parent = entry.get("parentSessionKey")
                print(f"   {sid}  [owns-this-chat]  name={entry.get('name')!r}")
                print(f"         agent={agent_id}")
                if parent:
                    print(f"         parent={parent}")
                print(f"         created={entry.get('createdAt')} updated={entry.get('updatedAt')}")
                logs = scan_logs(args.dsh_home, agent_id)
                if logs:
                    for path in logs:
                        print(f"         log: {path}")
                else:
                    print(f"         log: (not found; try: find {args.dsh_home}/feishu-bridge-sessions -name {agent_id})")

        for sid in children:
            entry = sessions.get(sid)
            if not isinstance(entry, dict):
                continue
            agent_id = entry.get("agentSessionID", "?")
            print(f"   {sid}  [child-of-this-chat]  name={entry.get('name')!r}")
            print(f"         agent={agent_id}")
            print(f"         parent={entry.get('parentSessionKey')} (spawned FROM this chat)")
            print(f"         created={entry.get('createdAt')} updated={entry.get('updatedAt')}")
            logs = scan_logs(args.dsh_home, agent_id)
            if logs:
                for path in logs:
                    print(f"         log: {path}")
            else:
                print(f"         log: (not found; try: find {args.dsh_home}/feishu-bridge-sessions -name {agent_id})")

        spawned_file = os.path.join(
            args.dsh_home, "feishu-bridge", bot, "sessions", f"{bot}_spawned.json"
        )
        if os.path.isfile(spawned_file):
            with open(spawned_file, encoding="utf-8") as handle:
                spawned = json.load(handle)
            chat_entry = spawned.get("chats", {}).get(args.chat_id)
            if isinstance(chat_entry, dict):
                print(
                    f"   spawned.json  -> phase={chat_entry.get('phase')!r} "
                    f"active={chat_entry.get('active')!r} icon={chat_entry.get('iconName')!r}"
                )

        state_file = os.path.join(args.dsh_home, "feishu-bridge", bot, "state.json")
        if os.path.isfile(state_file):
            with open(state_file, encoding="utf-8") as handle:
                state = json.load(handle)
            for override_key, override_dir in state.get("workspace_dir_overrides", {}).items():
                if args.chat_id in str(override_key):
                    print(f"   state.json    -> workspace override: {override_key} = {override_dir}")

    if not found_any:
        print(f"no session entries for {args.chat_id} in any bot's sessions.json", file=sys.stderr)
        print(
            "fallback: grep -rl --include=sessions.json --include=state.json "
            f"--include=*_spawned.json {args.chat_id} {args.dsh_home}/feishu-bridge/",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
