#!/usr/bin/env bash
# Otto installer for Ubuntu.
#
#   bash scripts/install.sh                 # everything: dependencies + service
#   bash scripts/install.sh --service-only  # service only (the rest is done)
#   bash scripts/install.sh --check         # changes nothing, just diagnoses
#
# Does not ask for sudo. The one step that needs root is authorizing the channel,
# and it lives in scripts/allow-channel-plugin.sh, deliberately kept separate.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.claude/channels/otto"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/otto.service"

MODE="full"
case "${1:-}" in
  --service-only) MODE="service" ;;
  --check)        MODE="check" ;;
  "")             ;;
  *) echo "usage: install.sh [--service-only|--check]" >&2; exit 2 ;;
esac

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "otto — installing in $OTTO_HOME"
echo

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
echo "checking the system:"

[ "$(uname -s)" = "Linux" ] \
  && ok "Linux" \
  || { bad "this installer is Linux/Ubuntu only (found $(uname -s))"; exit 1; }

CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
[ -x "$CLAUDE_BIN" ] \
  && ok "claude at $CLAUDE_BIN" \
  || { bad "claude not found — install Claude Code first"; exit 1; }

if command -v bun >/dev/null; then
  ok "bun at $(command -v bun)"
else
  warn "bun not found"
fi

command -v gog >/dev/null \
  && ok "gog available (saves tokens on the email scan)" \
  || warn "gog missing — optional, it only optimizes the email scan"

if [ -s "$STATE_DIR/.env" ]; then ok "Telegram token configured"
else warn "Telegram token missing — run /otto:setup in Claude"; fi

if [ -s "$STATE_DIR/access.json" ]; then ok "access.json present"
else warn "access.json missing — run /otto:setup in Claude"; fi

if [ -f "$OTTO_HOME/CLAUDE.md" ]; then
  if grep -q '{{' "$OTTO_HOME/CLAUDE.md" 2>/dev/null; then
    warn "CLAUDE.md still has {{placeholders}} to fill in"
  else
    ok "CLAUDE.md personalized"
  fi
else
  warn "CLAUDE.md missing — the personality comes from the template in templates/"
fi

POLICY="/etc/claude-code/managed-settings.json"
if [ -f "$POLICY" ] && grep -q '"otto"' "$POLICY" 2>/dev/null; then
  ok "channel authorized in the system policy"
else
  warn "channel not authorized — without this Otto replies but never starts a conversation"
  warn "  fix it with: sudo bash $OTTO_HOME/scripts/allow-channel-plugin.sh"
fi

[ "$MODE" = "check" ] && { echo; echo "diagnostics only — nothing was changed."; exit 0; }

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
if [ "$MODE" = "full" ]; then
  echo
  echo "dependencies:"
  if ! command -v bun >/dev/null; then
    echo "  installing bun…"
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null && ok "bun installed" || { bad "failed to install bun"; exit 1; }
  fi
  ( cd "$OTTO_HOME/otto" && bun install --no-summary >/dev/null 2>&1 ) \
    && ok "plugin dependencies installed" \
    || warn "bun install failed — the server retries on startup"
fi

mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------
echo
echo "service:"
mkdir -p "$UNIT_DIR"

sed -e "s|{{OTTO_HOME}}|$OTTO_HOME|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$OTTO_HOME/templates/otto.service.template" > "$UNIT"
ok "unit written to $UNIT"

# Without linger the service dies at logout — which is exactly when a proactive
# assistant needs to be up.
if loginctl enable-linger "$USER" 2>/dev/null; then
  ok "linger enabled (survives logout)"
else
  warn "could not enable linger — Otto will go down when you log out"
  warn "  fix it with: sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload 2>/dev/null

if systemctl --user enable --now otto.service 2>/dev/null; then
  sleep 3
  if [ "$(systemctl --user is-active otto.service 2>/dev/null)" = "active" ]; then
    ok "otto.service is up"
  else
    bad "the service started and died — see: journalctl --user -u otto.service -n 30"
    exit 1
  fi
else
  bad "systemctl failed — see: journalctl --user -u otto.service -n 30"
  exit 1
fi

echo
echo "done. useful commands:"
echo "  systemctl --user status otto.service      # how it's doing"
echo "  journalctl --user -u otto.service -f      # follow live"
echo "  systemctl --user restart otto.service     # restart"
echo
echo "send a 'hi' to your bot on Telegram to confirm."
