#!/usr/bin/env bash
# Otto installer for Linux and macOS.
#
#   bash scripts/install.sh                 # everything: dependencies + service
#   bash scripts/install.sh --service-only  # service only (the rest is done)
#   bash scripts/install.sh --check         # changes nothing, just diagnoses
#
# Three ways to keep Otto up, picked automatically:
#   systemd  — any Linux with a working `systemctl --user` (Ubuntu, Fedora, Arch…)
#   launchd  — macOS, as a LaunchAgent under your login session
#   manual   — Linux without systemd (Alpine, Void, Devuan, WSL without systemd);
#              nohup + pidfile, plus a @reboot crontab entry when cron exists
#
# Does not ask for sudo. The one step that needs root is authorizing the channel,
# and it lives in scripts/allow-channel-plugin.sh, deliberately kept separate.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.claude/channels/otto"
LOG="$STATE_DIR/otto.log"
PID_FILE="$STATE_DIR/otto.pid"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/otto.service"

PLIST_LABEL="com.otto.agent"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$PLIST_LABEL.plist"

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
# Platform
# ---------------------------------------------------------------------------
echo "checking the system:"

OS="$(uname -s)"
case "$OS" in
  Linux)
    # systemd --user is what actually matters, not the distro. `is-system-running`
    # answers "degraded"/"running"/"starting" when the user manager is there, and
    # fails outright when it isn't.
    if command -v systemctl >/dev/null && systemctl --user is-system-running >/dev/null 2>&1; then
      BACKEND="systemd"
    elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
      BACKEND="systemd"
    else
      BACKEND="manual"
    fi
    DISTRO="$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo Linux )"
    ok "Linux — ${DISTRO:-Linux}"
    [ "$BACKEND" = "systemd" ] \
      && ok "systemd user session available" \
      || warn "no systemd user session — falling back to a plain background process"
    POLICY="/etc/claude-code/managed-settings.json"
    ;;
  Darwin)
    BACKEND="launchd"
    ok "macOS $(sw_vers -productVersion 2>/dev/null || true) — using launchd"
    POLICY="/Library/Application Support/ClaudeCode/managed-settings.json"
    ;;
  *)
    bad "unsupported system: $OS (Linux and macOS only)"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
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
    if [ "$OS" = "Darwin" ] && command -v brew >/dev/null; then
      brew install oven-sh/bun/bun >/dev/null 2>&1
    fi
    if ! command -v bun >/dev/null; then
      curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    fi
    export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
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

case "$BACKEND" in

# --- systemd (any Linux with a user manager) --------------------------------
systemd)
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
  echo "  bash $OTTO_HOME/scripts/otto-ctl.sh status|logs|restart"
  echo "  systemctl --user status otto.service      # how it's doing"
  echo "  journalctl --user -u otto.service -f      # follow live"
  echo "  systemctl --user restart otto.service     # restart"
  ;;

# --- launchd (macOS) --------------------------------------------------------
launchd)
  mkdir -p "$PLIST_DIR"
  touch "$LOG" 2>/dev/null || true

  sed -e "s|{{OTTO_HOME}}|$OTTO_HOME|g" \
      -e "s|{{HOME}}|$HOME|g" \
      -e "s|{{LOG}}|$LOG|g" \
      -e "s|{{LABEL}}|$PLIST_LABEL|g" \
      "$OTTO_HOME/templates/otto.plist.template" > "$PLIST"
  ok "LaunchAgent written to $PLIST"

  UID_NUM="$(id -u)"

  # Is Otto actually up? launchctl answers relative to the caller's session
  # domain, so from an ssh session it can report nothing for a job that is very
  # much running — hence the pgrep last resort.
  running_pid() {
    local pid
    pid="$(launchctl list 2>/dev/null | awk -v l="$PLIST_LABEL" '$3 == l {print $1}')"
    [ -n "$pid" ] && [ "$pid" != "-" ] && { echo "$pid"; return 0; }
    pid="$(launchctl print "gui/$UID_NUM/$PLIST_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')"
    [ -n "$pid" ] && { echo "$pid"; return 0; }
    pid="$(pgrep -f "$OTTO_HOME/run.sh" 2>/dev/null | head -n1)"
    [ -n "$pid" ] && { echo "$pid"; return 0; }
    return 1
  }

  # bootout first: bootstrap on an already-loaded label fails with EEXIST, and
  # reinstalling over a running Otto is the common case. Give it a moment to
  # actually go away, or the bootstrap below races it.
  launchctl bootout "gui/$UID_NUM/$PLIST_LABEL" >/dev/null 2>&1
  launchctl unload "$PLIST" >/dev/null 2>&1
  for _ in 1 2 3 4 5; do running_pid >/dev/null || break; sleep 1; done

  launchctl enable "gui/$UID_NUM/$PLIST_LABEL" >/dev/null 2>&1
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null \
     || launchctl load -w "$PLIST" 2>/dev/null; then
    ok "agent loaded"
  else
    # EEXIST means it is already loaded, which is fine — only a genuinely dead
    # job is a failure, and the check below decides that.
    warn "launchctl reported an error loading the agent — checking whether it came up anyway"
  fi

  sleep 3

  if RUNNING_PID="$(running_pid)"; then
    ok "otto is up (pid $RUNNING_PID)"
  else
    bad "the agent started and died — see: tail -n 30 $LOG"
    exit 1
  fi

  # A LaunchAgent only lives inside a login session: logging out stops Otto, and
  # so does the machine going to sleep. Say it instead of letting them find out.
  warn "on macOS Otto runs while you're logged in — it stops at logout and pauses on sleep"
  warn "  to keep it up with the lid closed: System Settings → Lock Screen / Energy, or 'caffeinate -s'"

  echo
  echo "done. useful commands:"
  echo "  bash $OTTO_HOME/scripts/otto-ctl.sh status|logs|restart"
  echo "  launchctl list | grep $PLIST_LABEL"
  echo "  tail -f $LOG"
  echo "  launchctl kickstart -k gui/$UID_NUM/$PLIST_LABEL"
  ;;

# --- manual (Linux without systemd) -----------------------------------------
manual)
  # No supervisor here: start it, remember the pid, and let cron bring it back
  # after a reboot. Restart-on-crash is what you give up.
  if [ -s "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    sleep 2
  fi

  if command -v setsid >/dev/null; then
    setsid nohup bash "$OTTO_HOME/run.sh" >>"$LOG" 2>&1 &
  else
    nohup bash "$OTTO_HOME/run.sh" >>"$LOG" 2>&1 &
  fi
  echo $! > "$PID_FILE"
  sleep 3

  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "otto is up (pid $(cat "$PID_FILE"))"
  else
    bad "it started and died — see: tail -n 30 $LOG"
    exit 1
  fi

  if command -v crontab >/dev/null; then
    LINE="@reboot bash $OTTO_HOME/scripts/otto-ctl.sh start >/dev/null 2>&1"
    if crontab -l 2>/dev/null | grep -Fq "otto-ctl.sh start"; then
      ok "@reboot entry already in your crontab"
    elif { crontab -l 2>/dev/null; echo "$LINE"; } | crontab - 2>/dev/null; then
      ok "@reboot entry added to your crontab (starts with the machine)"
    else
      warn "could not write to crontab — Otto won't come back after a reboot"
      warn "  add by hand: $LINE"
    fi
  else
    warn "no cron here — Otto won't come back after a reboot"
    warn "  start it by hand: bash $OTTO_HOME/scripts/otto-ctl.sh start"
  fi

  warn "no service manager: if Otto crashes, nothing restarts it automatically"

  echo
  echo "done. useful commands:"
  echo "  bash $OTTO_HOME/scripts/otto-ctl.sh status   # is it up?"
  echo "  bash $OTTO_HOME/scripts/otto-ctl.sh logs     # follow live"
  echo "  bash $OTTO_HOME/scripts/otto-ctl.sh restart  # restart"
  ;;
esac

echo
echo "send a 'hi' to your bot on Telegram to confirm."
