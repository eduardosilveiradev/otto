#!/usr/bin/env bash
# Otto's long-running session. Called by systemd (otto.service), by launchd
# (com.otto.agent on macOS), or by hand.
#
# The channel plugin only survives in an INTERACTIVE session: in headless mode
# (-p) channels are never loaded, so the CLI connects the MCP server and kills it
# a few seconds later. Under systemd or launchd there is no terminal at all, so
# `script` fabricates a pty for claude to run its interactive loop without a real
# tty.
#
# Do not add --dangerously-load-development-channels: the flag swallows the
# following arguments as values and stalls startup on a consent screen. Otto is
# already permitted via allowedChannelPlugins in the system policy
# (/etc/claude-code/managed-settings.json on Linux, /Library/Application
# Support/ClaudeCode/managed-settings.json on macOS) — see
# scripts/allow-channel-plugin.sh.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# getent doesn't exist on macOS; dscl is the equivalent, and both are only a
# fallback for the rare launcher that starts us without HOME.
if [ -z "${HOME:-}" ]; then
  if command -v getent >/dev/null; then
    HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
  else
    HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  fi
fi
export HOME
# /opt/homebrew/bin is where Homebrew puts things on Apple Silicon; harmless
# elsewhere.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
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

# --channels is variadic (`<servers...>`), so it greedily eats every following
# token that doesn't start with a dash. Keep it last: a flag added after it
# would be swallowed as a channel name rather than parsed.
CLAUDE_ARGS=(--permission-mode auto --channels plugin:otto@otto)

# `script` exists only to fabricate a pty when we have no terminal. Starting from
# a real terminal it is a downgrade: it never forwards SIGWINCH, so the TUI is
# stuck at 80x24 and the terminal is left in raw mode.
if [ -t 0 ] && [ -t 1 ]; then
  exec "$CLAUDE" "${CLAUDE_ARGS[@]}"
fi

# Three incompatible `script` commands in the wild: util-linux (most Linux
# distros) takes -c and the file last, busybox (Alpine and friends) takes -c but
# not -e/-f, and BSD (macOS) has no -c at all and wants the file before the
# command.
if ! command -v script >/dev/null; then
  echo "otto: 'script' not found — running without a pty, channels may not load" >&2
  exec "$CLAUDE" "${CLAUDE_ARGS[@]}"
fi

CMDLINE="$CLAUDE $(printf '%q ' "${CLAUDE_ARGS[@]}")"

if script --version 2>/dev/null | grep -qi util-linux; then
  exec script -qefc "$CMDLINE" /dev/null
elif script --help 2>&1 | grep -qi busybox; then
  exec script -qc "$CMDLINE" /dev/null
fi
exec script -q /dev/null "$CLAUDE" "${CLAUDE_ARGS[@]}"
