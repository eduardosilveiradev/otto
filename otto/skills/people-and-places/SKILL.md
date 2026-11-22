---
name: people-and-places
description: "Use when discussing people, birthdays, keeping in touch, cities or places; before note_contact, who, note_place or places, or drafting a message to someone."
---

## People

The graph is what they told you, plus the attendees of calendar events they were
in (the channel adds those itself). Never populate it from a mailbox: a name on a
header is a sender, not someone they know.

- They explain who someone is, where they are, or anything worth having next
  time → `note_contact`. Their words, not your summary of them.
- Set `timezone` whenever they place someone in a city — it is the whole reason
  "when can I call her" has an answer. A move or a job change is recorded the
  same way; the previous value is kept as a dated note automatically.
- `who` before writing to or about someone, and before asking them anything about
  a person. Asking twice about someone they already explained is the thing they
  will notice.
- They say how often they want to stay in touch with someone — "remind me to
  call mum monthly", "I don't want to lose touch with Sam" — → `note_contact`
  with `cadence` (weekly, fortnightly, monthly, quarterly, every N
  days/weeks/months). Only people with a cadence are ever nudged; never set one
  they didn't ask for. When the clock runs out the channel sends the one nudge
  per period (priority normal, at most `keepInTouch.weeklyCap` a week, default
  2, in `access.json`) with [draft a message] [snooze a month] [stop for them].
  Snooze and stop are settled in the channel; the draft reaches you as a button
  event — `who` first, then draft in their style and show it. Don't raise an
  overdue check-in off `who` yourself and don't arm a trigger for it.
- They tell you they spoke to someone — "called Alex yesterday", "had lunch
  with Sam" → `note_contact` with `touched:true` (plus `note` for anything worth
  keeping). That resets the clock. Apart from a nudge or a snooze, the only
  other thing that does is a calendar event the channel matches to them, so
  record it. "Stop reminding me about X" → `cadence:"off"`.
- `who(drift:true)` (silence measured against the rhythm Otto has observed) is
  still evidence for a conversation, never a reason to message anyone on its own.
- They mention a place — recommended, wanted, been, loved, or to avoid →
  `note_place` in their words, with `recommendedBy` when someone suggested it.
  Same name in the same city updates it. `places` before suggesting anywhere;
  never add one from their mail.
- They tell you someone's birthday → `note_contact` with `birthday` as `MM-DD`,
  or `YYYY-MM-DD` only when they gave the year. Never from mail. The channel
  sends the one nudge (`birthdays.leadDays`, default 3, in `access.json`, counted
  in that person's timezone) with [remind me on the day] [draft a message], and
  the day itself shows in the brief. Don't add a trigger or a second mention.
