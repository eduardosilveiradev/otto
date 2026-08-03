#!/usr/bin/env bash
# Libera o plugin de canal do Poke na política do Claude Code.
# Rode com sudo:  sudo bash scripts/allow-channel-plugin.sh
#
# Sem isto o Poke ainda responde quando você escreve, mas nunca começa uma
# conversa — nada de lembrete, nada de aviso de e-mail.
#
# Cuidado herdado do discord-channel: definir allowedChannelPlugins SUBSTITUI a
# lista embutida (por isso os plugins oficiais são repetidos abaixo), e um
# arquivo de política não-nulo precisa de channelsEnabled true, senão todo canal
# morre.

set -euo pipefail

DIR="/etc/claude-code"
FILE="$DIR/managed-settings.json"

if [ "$(id -u)" -ne 0 ]; then
  echo "erro: rode com sudo — $FILE é do root." >&2
  exit 1
fi

mkdir -p "$DIR"

if [ -f "$FILE" ]; then
  BACKUP="$FILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$FILE" "$BACKUP"
  echo "política anterior salva em: $BACKUP"
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
    {"marketplace": "poke-core", "plugin": "poke"},
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

print("escrito:", path)
PY

chmod 644 "$FILE"
echo "pronto. o canal do Poke está autorizado."
