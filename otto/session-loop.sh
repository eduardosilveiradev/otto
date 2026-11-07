#!/bin/bash
# Runs claude inside the tmux session and brings it back when it dies.
# usage: session-loop.sh <stderr log> <exit-code file> <claude> <args...>
#
# A clean exit (/exit, code 0) ends the session for good. Anything else (a crash,
# a kill, an OOM) relaunches with --continue, which picks the conversation back
# up from its transcript in this cwd. Five crashes inside five minutes stop the
# loop, so a session that dies on boot doesn't spin forever.
# Every start resumes too, unless OTTO_FRESH=1 asks for a new conversation.
err=$1 code=$2 claude=$3
shift 3
resume=(--continue)
[ "${OTTO_FRESH:-}" = 1 ] && resume=()
crashes=()
while :; do
  # --channels is variadic and must stay last, so --continue goes first.
  "$claude" "${resume[@]}" "$@" 2>> "$err"
  rc=$?
  echo "$rc" > "$code"
  [ "$rc" = 0 ] && exit 0
  now=$(date +%s)
  recent=()
  for t in "${crashes[@]}" "$now"; do [ $((now - t)) -lt 300 ] && recent+=("$t"); done
  crashes=("${recent[@]}")
  echo "otto: claude exited $rc at $(date), resuming ($((${#crashes[@]}))/5 in 5 min)" >> "$err"
  [ "${#crashes[@]}" -ge 5 ] && { echo "otto: crash loop, giving up" >> "$err"; exit "$rc"; }
  resume=(--continue)
  sleep 3
done
