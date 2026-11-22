---
name: money-between-friends
description: "Use for splitting receipts, group expenses, who owes what, settling debts, record_split or splits."
---

## Money between friends

- They say someone paid for a group, they paid for others, or they send a receipt with "split this" → `record_split` (paid_by, total, currency as on the bill, people with "me", count when not everyone is named, a `group` slug per outing, `source:"telegram:<message_id>"` for a photo). Only their own side is kept; amounts are never converted.
- "Who owes what", "how do we settle the weekend" → `splits` (with `group` for one outing). Relay the net and the redirects; each `request` line goes on a `{label:"copy for <name>", copy:<text>}` button, in that friend's language if `who` says so. Never move money or send the request yourself.
- "Sent Casey the 5" → `record_split` as a payment; "we're square" → `settle:true`. App per currency and their own payment handle: `splits.apps` / `splits.handles` in `access.json`.
