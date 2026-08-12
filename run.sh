#!/usr/bin/env bash
# Otto's long-running session. Called by systemd (otto.service) or by hand.
#
# The channel plugin only survives in an INTERACTIVE session: in headless mode
# (-p) channels are never loaded, so the CLI connects the MCP server and kills it
# a few seconds later. Under systemd there is no terminal at all, so `script`
# fabricates a pty for claude to run its interactive loop without a real tty.
#
# Do not add --dangerously-load-development-channels: the flag swallows the
# following arguments as values and stalls startup on a consent screen. Otto is
# already permitted via allowedChannelPlugins in the system policy
# (/etc/claude-code/managed-settings.json) — see scripts/allow-channel-plugin.sh.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export TERM="${TERM:-xterm-256color}"

# Tells server.ts that THIS session is the one that actually receives channel
# injections, and may therefore take the Telegram token. Any other session that
# loads the plugin starts the server too, but without this — and without the
# client advertising the channel capability — it gets the tools only, instead of
# eating the user's messages.
export OTTO_CHANNEL_HOST=1

CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
if [ ! -x "$CLAUDE" ]; then
  echo "otto: claude not found (looked in PATH and in $HOME/.local/bin)" >&2
  exit 1
fi

# The cwd cannot be the marketplace root; a subdirectory still inherits the
# CLAUDE.md files from the cwd and its ancestors — which is how the personality
# gets in.
RUN_DIR="$OTTO_HOME/runtime"
mkdir -p "$RUN_DIR"
cd "$RUN_DIR" || exit 1

CLAUDE_ARGS=(--channels plugin:otto@otto --permission-mode auto)

# `script` exists only to fabricate a pty when we have no terminal. Starting from
# a real terminal it is a downgrade: it never forwards SIGWINCH, so the TUI is
# stuck at 80x24 and the terminal is left in raw mode.
if [ -t 0 ] && [ -t 1 ]; then
  exec "$CLAUDE" "${CLAUDE_ARGS[@]}"
fi

# util-linux (Ubuntu) uses -c "command"; the BSD/macOS script has a different
# argument order.
if script --version 2>/dev/null | grep -qi util-linux; then
  exec script -qefc "$CLAUDE $(printf '%q ' "${CLAUDE_ARGS[@]}")" /dev/null
fi
exec script -q /dev/null "$CLAUDE" "${CLAUDE_ARGS[@]}"
