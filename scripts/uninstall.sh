#!/usr/bin/env bash
# Takes Otto off this machine — the reverse of install.sh and the setup skill.
#
#   bash scripts/uninstall.sh                # dry run: lists what it would do, changes nothing
#   bash scripts/uninstall.sh --yes          # does it
#   bash scripts/uninstall.sh --yes --purge  # also deletes ~/.otto/state (token, memory, history)
#
# What it undoes:
#   - the service: launchd LaunchAgent (macOS), systemd user unit, or the plain
#     background process and its @reboot crontab entry
#   - Otto's `tailscale serve` path (/app) and the relay's funnel path (/telegram),
#     only those — any other serve config you have is left alone
#   - Otto's entry in the Claude Code managed-settings policy, written by
#     allow-channel-plugin.sh. That file is owned by root, so this step runs
#     `sudo` and asks for your password.
#
# What it leaves: ~/.otto/state unless --purge, and the code in this folder.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${OTTO_STATE_DIR:-$HOME/.otto/state}"
PID_FILE="$STATE_DIR/otto.pid"
UNIT="$HOME/.config/systemd/user/otto.service"
PLIST_LABEL="com.otto.agent"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
OLD_STATE="$HOME/.claude/channels/otto"

YES=0; PURGE=0
for arg in "$@"; do
  case "$arg" in
    --yes)   YES=1 ;;
    --purge) PURGE=1 ;;
    *) echo "usage: uninstall.sh [--yes] [--purge]" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) POLICY="/Library/Application Support/ClaudeCode/managed-settings.json" ;;
  *)      POLICY="/etc/claude-code/managed-settings.json" ;;
esac

# Every change goes through here: printed in a dry run, executed with --yes.
run() {
  if [ "$YES" = 1 ]; then
    echo "  → ${LABEL:-$*}"
    "$@" || echo "    (failed, carrying on)"
  else
    echo "  would run: ${LABEL:-$*}"
  fi
}
skip() { echo "  - $1"; }

[ "$YES" = 1 ] && echo "otto — uninstalling" || echo "otto — dry run (nothing changes; add --yes to do it)"
echo

echo "service:"
FOUND=0
if [ -f "$PLIST" ]; then
  FOUND=1
  run launchctl bootout "gui/$(id -u)/$PLIST_LABEL"
  run rm -f "$PLIST"
fi
if [ -f "$UNIT" ]; then
  FOUND=1
  run systemctl --user disable --now otto.service
  run rm -f "$UNIT"
  run systemctl --user daemon-reload
fi
if [ -s "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  FOUND=1
  # run.sh runs claude in its own process group; take the whole group down.
  run kill -- "-$(cat "$PID_FILE")"
fi
if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -Fq "otto-ctl.sh start"; then
  FOUND=1
  run sh -c 'crontab -l | grep -Fv "otto-ctl.sh start" | crontab -'
fi
[ "$FOUND" = 0 ] && skip "no service installed"

echo
echo "tailscale:"
SERVE="$(command -v tailscale >/dev/null && tailscale serve status 2>/dev/null || true)"
# The https port a path pointing at Otto's listener is served on. `off` only
# matches on the same port, and it isn't always 443 (the relay uses 10000).
port_of() {
  printf '%s\n' "$SERVE" | awk -v path="$1" '
    /^https:\/\// { port = 443; if (match($1, /:[0-9]+$/)) port = substr($1, RSTART + 1) }
    $2 == path && $NF ~ /127\.0\.0\.1:4589/ { print port; exit }'
}
TS=0
P="$(port_of /app)"
[ -n "$P" ] && { TS=1; run tailscale serve --https="$P" --set-path /app off; }
P="$(port_of /telegram)"
[ -n "$P" ] && { TS=1; run tailscale funnel --https="$P" --set-path /telegram off; }
[ "$TS" = 0 ] && skip "Otto has nothing in tailscale serve or funnel"

echo
echo "channel policy:"
if [ -f "$POLICY" ] && grep -q '"otto"' "$POLICY" 2>/dev/null; then
  # The same runtime choice as allow-channel-plugin.sh: python3 can be a stub on macOS.
  if python3 -c '' >/dev/null 2>&1; then
    LABEL="sudo python3: drop the otto entry from $POLICY" run sudo python3 -c '
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["allowedChannelPlugins"] = [e for e in s.get("allowedChannelPlugins", []) if e != {"marketplace": "otto", "plugin": "otto"}]
open(p, "w").write(json.dumps(s, indent=2) + "\n")' "$POLICY"
  else
    JS="$(command -v node || command -v bun || true)"
    if [ -n "$JS" ]; then
      LABEL="sudo $JS: drop the otto entry from $POLICY" run sudo "$JS" -e '
const fs = require("fs"); const p = process.argv[process.argv.length - 1];
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.allowedChannelPlugins = (s.allowedChannelPlugins || []).filter(e => !(e && e.marketplace === "otto" && e.plugin === "otto"));
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");' "$POLICY"
    else
      skip "need python3, node or bun to edit $POLICY — remove the otto entry by hand (sudo)"
    fi
  fi
  [ "$YES" = 1 ] || echo "    (needs sudo — it will ask for your computer password)"
  echo "    the official channel entries and channelsEnabled stay; other channel plugins keep working"
else
  skip "Otto is not in $POLICY"
fi

echo
echo "state:"
if [ "$PURGE" = 1 ]; then
  [ -e "$STATE_DIR" ] && run rm -rf "$STATE_DIR" || skip "no $STATE_DIR"
  [ -L "$OLD_STATE" ] && run rm -f "$OLD_STATE"
else
  skip "keeping $STATE_DIR (bot token, memory, history) — --purge deletes it"
fi

echo
echo "left for you:"
echo "  - the code in $OTTO_HOME — delete the folder when you're done with it"
echo "  - the Claude plugin: claude plugin uninstall otto@otto"
echo "  - the Telegram bot itself: /deletebot in @BotFather"
[ "$YES" = 1 ] || { echo; echo "dry run — nothing was changed. run again with --yes to do it."; }
