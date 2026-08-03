#!/usr/bin/env bash
# Sessão longa do Poke. Chamado pelo systemd (poke.service) ou à mão.
#
# O plugin de canal só sobrevive numa sessão INTERATIVA: no modo headless (-p) os
# canais nunca são carregados, então o CLI conecta o servidor MCP e o mata alguns
# segundos depois. Sob o systemd não existe terminal nenhum, então `script`
# fabrica um pty pro claude rodar seu loop interativo sem tty de verdade.
#
# Não adicione --dangerously-load-development-channels: a flag consome os
# argumentos seguintes como valores e trava a partida numa tela de consentimento.
# O poke já é permitido via allowedChannelPlugins na política do sistema
# (/etc/claude-code/managed-settings.json) — veja scripts/allow-channel-plugin.sh.
set -uo pipefail

POKE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export TERM="${TERM:-xterm-256color}"

# Diz ao server.ts que ESTA sessão é a que realmente recebe injeções do canal, e
# portanto pode tomar o token do Telegram. Qualquer outra sessão que carregue o
# plugin sobe o servidor também, mas sem isto — e sem o cliente anunciar a
# capacidade de canal — ela fica só com as ferramentas, em vez de comer as
# mensagens do usuário.
export POKE_CHANNEL_HOST=1

CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
if [ ! -x "$CLAUDE" ]; then
  echo "poke: claude não encontrado (procurei no PATH e em $HOME/.local/bin)" >&2
  exit 1
fi

# O cwd não pode ser a raiz do marketplace; um subdiretório ainda herda os
# CLAUDE.md do cwd e dos ancestrais — que é como a personalidade entra.
RUN_DIR="$POKE_HOME/runtime"
mkdir -p "$RUN_DIR"
cd "$RUN_DIR" || exit 1

CLAUDE_ARGS=(--channels plugin:poke@poke-core --permission-mode auto)

# `script` existe só pra fabricar um pty quando não temos terminal. Partindo de
# um terminal de verdade ele é um downgrade: nunca repassa SIGWINCH, então a TUI
# fica presa em 80x24 e o terminal sai em modo raw.
if [ -t 0 ] && [ -t 1 ]; then
  exec "$CLAUDE" "${CLAUDE_ARGS[@]}"
fi

# util-linux (Ubuntu) usa -c "comando"; o script do BSD/macOS tem outra ordem.
if script --version 2>/dev/null | grep -qi util-linux; then
  exec script -qefc "$CLAUDE $(printf '%q ' "${CLAUDE_ARGS[@]}")" /dev/null
fi
exec script -q /dev/null "$CLAUDE" "${CLAUDE_ARGS[@]}"
