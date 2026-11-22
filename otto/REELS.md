# Saved short videos

Use `bun scripts/watch-video.ts "<url>"` followed by the watch-video options.
This wraps the installed watch-video skill, preserving its frame, metadata,
comment and transcript output. `OTTO_WATCH_VIDEO_SCRIPT` can select a different
installation of `watch.sh`; by default it is found under `$HOME/.claude/skills`,
then the Codex skills folders, and a missing install is reported as such.

An Instagram login or rate-limit failure gets one retry with `--cookies chrome`,
which the skill passes to yt-dlp as `--cookies-from-browser chrome`. Cookies are
read directly from the user's signed-in Chrome profile, never exported, logged
or saved by this helper. Download diagnostics stay in memory and are replaced
by a generic failure message. Chrome/Keychain access can still fail; report that
the video could not be watched rather than inventing a summary. No browser retry
is made for other sites or unrelated failures.

Save title, one-line gist and URL on separate lines in a saved note. Add `reel`
and exactly one category from CLAUDE.md's Links rules. This is session-assigned,
not inferred by the digest. Existing untagged notes remain searchable; they need
classification before appearing in the digest.

The existing scheduler checks Sunday at 10:00 in the machine's local timezone
(or on a later Sunday restart). `reels.json` records the last local Sunday before
delivery, following the birthday nudge convention. Empty lists are silent.
Normal-priority delivery honours quiet hours, calendar holds and snooze. Each
item has a numbered tried-it button carrying its saved-note ID; Telegram, app
and WhatsApp use the same handler. A tap adds `tried` without deleting the note
or its category; removing that tag makes it eligible again. As with birthday
nudges, a delivery failure after stamping waits until the following week.
