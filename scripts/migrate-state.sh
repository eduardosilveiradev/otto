#!/usr/bin/env bash
# Moves Otto's state from the old location (~/.claude/channels/otto) to
# ~/.otto/state, once, and leaves a symlink behind so anything still pointing at
# the old path (an old LaunchAgent's log path, a stray script) keeps working.
#
# Called by run.sh, install.sh and otto-ctl.sh before anything creates the new
# directory. Safe to run any number of times:
#   - the old path is already a symlink → done before, nothing to do
#   - no old directory → fresh install, just make sure the new one exists
#   - both exist → never merges; the new one wins, the old one is left alone
# The move is a same-filesystem rename, so files keep their inodes and an
# already-open log keeps writing to the right place.
#
# To undo: stop Otto, `rm ~/.claude/channels/otto`, then
# `mv ~/.otto/state ~/.claude/channels/otto`.
set -uo pipefail

OLD="$HOME/.claude/channels/otto"
NEW="${OTTO_STATE_DIR:-$HOME/.otto/state}"

[ -L "$OLD" ] && exit 0

if [ ! -d "$OLD" ]; then
  mkdir -p "$NEW" && chmod 700 "$NEW"
  exit 0
fi

# Anything already in the new directory means someone set it up by hand: don't
# guess which copy is real, and never mv into a non-empty directory (that would
# nest the old state one level down instead of replacing it).
if [ -e "$NEW" ] && ! rmdir "$NEW" 2>/dev/null; then
  echo "otto: both $OLD and $NEW exist; using $NEW, $OLD left untouched" >&2
  exit 0
fi

mkdir -p "$(dirname "$NEW")"
mv "$OLD" "$NEW" && chmod 700 "$NEW" && ln -s "$NEW" "$OLD" \
  && echo "otto: state moved from $OLD to $NEW (symlink left behind)" >&2
