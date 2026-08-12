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

# The policy file lives somewhere else on macOS.
case "$(uname -s)" in
  Darwin) DIR="/Library/Application Support/ClaudeCode" ;;
  Linux)  DIR="/etc/claude-code" ;;
  *) echo "error: unsupported system: $(uname -s)" >&2; exit 1 ;;
esac
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

# python3 is there on every Linux, but on macOS it's a stub that fails until the
# Xcode command line tools are installed — so test it, and fall back to node/bun,
# one of which is always around next to Claude Code.
RUNTIME=""
if python3 -c '' >/dev/null 2>&1; then RUNTIME="python3"
elif command -v node >/dev/null 2>&1; then RUNTIME="node"
elif command -v bun >/dev/null 2>&1; then RUNTIME="bun"
else
  echo "error: need python3, node or bun to edit the JSON policy — none found." >&2
  exit 1
fi

if [ "$RUNTIME" = "python3" ]; then
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
else
"$RUNTIME" - "$FILE" <<'JS'
const fs = require("fs");
const path = process.argv[2];

let settings = {};
if (fs.existsSync(path)) {
  const content = fs.readFileSync(path, "utf8").trim();
  if (content) settings = JSON.parse(content);
}

const wanted = [
  { marketplace: "claude-plugins-official", plugin: "discord" },
  { marketplace: "claude-plugins-official", plugin: "telegram" },
  { marketplace: "claude-plugins-official", plugin: "fakechat" },
  { marketplace: "claude-plugins-official", plugin: "imessage" },
  { marketplace: "otto", plugin: "otto" },
];

const merged = Array.isArray(settings.allowedChannelPlugins) ? [...settings.allowedChannelPlugins] : [];
for (const entry of wanted) {
  const already = merged.some(
    (e) => e && e.marketplace === entry.marketplace && e.plugin === entry.plugin,
  );
  if (!already) merged.push(entry);
}

settings.allowedChannelPlugins = merged;
settings.channelsEnabled = true;

fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
console.log("wrote:", path);
JS
fi

chmod 644 "$FILE"
echo "done. Otto's channel is authorized."
