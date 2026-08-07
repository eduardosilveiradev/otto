#!/usr/bin/env bash
# Instalador do Otto para Ubuntu.
#
#   bash scripts/install.sh                 # tudo: dependências + serviço
#   bash scripts/install.sh --service-only  # só o serviço (o resto já foi feito)
#   bash scripts/install.sh --check         # não muda nada, só diagnostica
#
# Não pede sudo. A única etapa que precisa de root é liberar o canal, e ela mora
# em scripts/allow-channel-plugin.sh, de propósito separada.
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
  *) echo "uso: install.sh [--service-only|--check]" >&2; exit 2 ;;
esac

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "otto — instalação em $OTTO_HOME"
echo

# ---------------------------------------------------------------------------
# Diagnóstico
# ---------------------------------------------------------------------------
echo "verificando o sistema:"

[ "$(uname -s)" = "Linux" ] \
  && ok "Linux" \
  || { bad "este instalador é só pra Linux/Ubuntu (achei $(uname -s))"; exit 1; }

CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
[ -x "$CLAUDE_BIN" ] \
  && ok "claude em $CLAUDE_BIN" \
  || { bad "claude não encontrado — instale o Claude Code antes"; exit 1; }

if command -v bun >/dev/null; then
  ok "bun em $(command -v bun)"
else
  warn "bun não encontrado"
fi

command -v gog >/dev/null \
  && ok "gog disponível (economiza tokens na varredura de e-mail)" \
  || warn "gog ausente — opcional, só otimiza a varredura de e-mail"

if [ -s "$STATE_DIR/.env" ]; then ok "token do Telegram configurado"
else warn "token do Telegram ausente — rode /otto:setup no Claude"; fi

if [ -s "$STATE_DIR/access.json" ]; then ok "access.json presente"
else warn "access.json ausente — rode /otto:setup no Claude"; fi

if [ -f "$OTTO_HOME/CLAUDE.md" ]; then
  if grep -q '{{' "$OTTO_HOME/CLAUDE.md" 2>/dev/null; then
    warn "CLAUDE.md ainda tem {{placeholders}} por preencher"
  else
    ok "CLAUDE.md personalizado"
  fi
else
  warn "CLAUDE.md ausente — a personalidade sai do template em templates/"
fi

POLICY="/etc/claude-code/managed-settings.json"
if [ -f "$POLICY" ] && grep -q '"otto"' "$POLICY" 2>/dev/null; then
  ok "canal autorizado na política do sistema"
else
  warn "canal não autorizado — sem isso o Otto responde mas nunca puxa assunto"
  warn "  corrija com: sudo bash $OTTO_HOME/scripts/allow-channel-plugin.sh"
fi

[ "$MODE" = "check" ] && { echo; echo "diagnóstico apenas — nada foi alterado."; exit 0; }

# ---------------------------------------------------------------------------
# Dependências
# ---------------------------------------------------------------------------
if [ "$MODE" = "full" ]; then
  echo
  echo "dependências:"
  if ! command -v bun >/dev/null; then
    echo "  instalando o bun…"
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null && ok "bun instalado" || { bad "falhou ao instalar o bun"; exit 1; }
  fi
  ( cd "$OTTO_HOME/otto" && bun install --no-summary >/dev/null 2>&1 ) \
    && ok "dependências do plugin instaladas" \
    || warn "bun install falhou — o servidor tenta de novo ao subir"
fi

mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# ---------------------------------------------------------------------------
# Serviço
# ---------------------------------------------------------------------------
echo
echo "serviço:"
mkdir -p "$UNIT_DIR"

sed -e "s|{{OTTO_HOME}}|$OTTO_HOME|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$OTTO_HOME/templates/otto.service.template" > "$UNIT"
ok "unidade escrita em $UNIT"

# Sem linger o serviço morre no logout — que é justamente quando um assistente
# proativo precisa estar de pé.
if loginctl enable-linger "$USER" 2>/dev/null; then
  ok "linger ligado (sobrevive ao logout)"
else
  warn "não consegui ligar o linger — o Otto vai cair quando você deslogar"
  warn "  corrija com: sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload 2>/dev/null

if systemctl --user enable --now otto.service 2>/dev/null; then
  sleep 3
  if [ "$(systemctl --user is-active otto.service 2>/dev/null)" = "active" ]; then
    ok "otto.service no ar"
  else
    bad "o serviço subiu e caiu — veja: journalctl --user -u otto.service -n 30"
    exit 1
  fi
else
  bad "systemctl falhou — veja: journalctl --user -u otto.service -n 30"
  exit 1
fi

echo
echo "pronto. comandos úteis:"
echo "  systemctl --user status otto.service      # como está"
echo "  journalctl --user -u otto.service -f      # acompanhar ao vivo"
echo "  systemctl --user restart otto.service     # reiniciar"
echo
echo "manda um 'oi' pro seu bot no Telegram pra confirmar."
