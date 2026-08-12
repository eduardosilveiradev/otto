#!/usr/bin/env bash
# Authorizes Otto's channel plugin in the Claude Code policy.
# Run it with sudo:  sudo bash scripts/allow-channel-plugin.sh
#
# Without this Otto still replies when you write to it, but it never starts a
# conversation — no reminders, no email alerts.
#
# Caveat inherited from discord-channel: setting allowedChannelPlugins REPLACES
# the built-in list (which is why the official plugins are repeated below), and a
# non-empty policy file needs channelsEnabled true, or every channel dies.

set -euo pipefail

DIR="/etc/claude-code"
FILE="$DIR/managed-settings.json"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run with sudo — $FILE is owned by root." >&2
  exit 1
fi

mkdir -p "$DIR"

if [ -f "$FILE" ]; then
  BACKUP="$FILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$FILE" "$BACKUP"
  echo "previous policy saved to: $BACKUP"
fi

python3 - "$FILE" <<'PY'
import json, os, sys

path = sys.argv[1]
settings = {}
if os.path.exists(path):
    content = open(path).read().strip()
    if content:
        settings = json.loads(content)

wanted = [
    {"marketplace": "claude-plugins-official", "plugin": "discord"},
    {"marketplace": "claude-plugins-official", "plugin": "telegram"},
    {"marketplace": "claude-plugins-official", "plugin": "fakechat"},
    {"marketplace": "claude-plugins-official", "plugin": "imessage"},
    {"marketplace": "otto", "plugin": "otto"},
]

merged = list(settings.get("allowedChannelPlugins") or [])
for entry in wanted:
    if entry not in merged:
        merged.append(entry)

settings["allowedChannelPlugins"] = merged
settings["channelsEnabled"] = True

with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print("wrote:", path)
PY

chmod 644 "$FILE"
echo "done. Otto's channel is authorized."
