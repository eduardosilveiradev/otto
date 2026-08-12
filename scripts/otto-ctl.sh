#!/usr/bin/env bash
# One set of commands for Otto, whichever way it's kept alive:
#
#   bash scripts/otto-ctl.sh start|stop|restart|status|logs
#
# It picks the backend the same way install.sh did — systemd unit, launchd
# LaunchAgent, or a plain pidfile — so the same command works on Ubuntu, Fedora,
# Alpine and macOS.
set -uo pipefail

OTTO_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$HOME/.claude/channels/otto"
LOG="$STATE_DIR/otto.log"
PID_FILE="$STATE_DIR/otto.pid"

UNIT="$HOME/.config/systemd/user/otto.service"
PLIST_LABEL="com.otto.agent"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
UID_NUM="$(id -u)"

if [ -f "$PLIST" ]; then
  BACKEND="launchd"
elif [ -f "$UNIT" ] && command -v systemctl >/dev/null; then
  BACKEND="systemd"
else
  BACKEND="manual"
fi

CMD="${1:-status}"

launchd_pid() {
  # launchctl answers relative to the caller's session domain, so a job that is
  # running can look absent from an ssh session — pgrep is the tiebreaker.
  local pid
  pid="$(launchctl list 2>/dev/null | awk -v l="$PLIST_LABEL" '$3 == l {print $1}')"
  [ -n "$pid" ] && [ "$pid" != "-" ] && { echo "$pid"; return 0; }
  pid="$(launchctl print "gui/$UID_NUM/$PLIST_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')"
  [ -n "$pid" ] && { echo "$pid"; return 0; }
  pid="$(pgrep -f "$OTTO_HOME/run.sh" 2>/dev/null | head -n1)"
  [ -n "$pid" ] && { echo "$pid"; return 0; }
  return 1
}

manual_pid() {
  [ -s "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE")"
  kill -0 "$pid" 2>/dev/null && echo "$pid"
}

manual_start() {
  if manual_pid >/dev/null; then
    echo "otto is already up (pid $(manual_pid))"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  if command -v setsid >/dev/null; then
    setsid nohup bash "$OTTO_HOME/run.sh" >>"$LOG" 2>&1 &
  else
    nohup bash "$OTTO_HOME/run.sh" >>"$LOG" 2>&1 &
  fi
  echo $! > "$PID_FILE"
  sleep 2
  manual_pid >/dev/null && echo "otto is up (pid $(cat "$PID_FILE"))" \
    || { echo "it started and died — see: tail -n 30 $LOG" >&2; return 1; }
}

manual_stop() {
  local pid; pid="$(manual_pid)" || { echo "otto is not running"; return 0; }
  # run.sh execs claude under `script`, so kill the whole process group when we
  # have one; otherwise the child keeps the Telegram token and the next start
  # collides with a 409.
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  sleep 2
  manual_pid >/dev/null && kill -9 -- "-$pid" 2>/dev/null
  rm -f "$PID_FILE"
  echo "otto stopped"
}

case "$BACKEND:$CMD" in
  systemd:start)   systemctl --user start otto.service && systemctl --user is-active otto.service ;;
  systemd:stop)    systemctl --user stop otto.service && echo "otto stopped" ;;
  systemd:restart) systemctl --user restart otto.service && systemctl --user is-active otto.service ;;
  systemd:status)  systemctl --user status otto.service --no-pager ;;
  systemd:logs)    journalctl --user -u otto.service -f ;;

  launchd:start)   launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" ;;
  launchd:stop)    launchctl bootout "gui/$UID_NUM/$PLIST_LABEL" 2>/dev/null || launchctl unload "$PLIST"; echo "otto stopped" ;;
  launchd:restart) launchctl kickstart -k "gui/$UID_NUM/$PLIST_LABEL" ;;
  launchd:status)
    if PID="$(launchd_pid)"; then echo "active (pid $PID)"
    elif launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
      echo "loaded but not running — see: tail -n 30 $LOG"; exit 3
    else echo "not running — run: bash scripts/otto-ctl.sh start"; exit 3; fi ;;
  launchd:logs)    tail -f "$LOG" ;;

  manual:start)    manual_start ;;
  manual:stop)     manual_stop ;;
  manual:restart)  manual_stop; manual_start ;;
  manual:status)
    if PID="$(manual_pid)"; then echo "active (pid $PID)"
    else echo "not running — run: bash scripts/otto-ctl.sh start"; exit 3; fi ;;
  manual:logs)     tail -f "$LOG" ;;

  *) echo "usage: otto-ctl.sh [start|stop|restart|status|logs]" >&2; exit 2 ;;
esac
