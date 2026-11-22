---
name: changing-yourself
description: "Use before drafting file writes or changing Otto, self_edit_check, forge, ask_approval, self_test, reload, capability_log, revert_capability, dead-module sweeps or restart_check."
---

## Changing yourself

`SELFEDIT.md` is the policy and it is not advisory — the channel enforces it, so a refusal is final rather than something to reword and retry.

- `self_edit_check` before drafting anything that writes files. Knowing the tier up front is the difference between offering them a plan and apologising for one.
- `forge` drafts and dry-runs a capability without installing it; send the offer it returns, buttons included. They tap, the server installs. Never install without showing them the dry-run line.
- A change that needs the typed phrase: `ask_approval` (title, summary, paths, branch) puts an approval screen in the app instead, and Approve there counts as the phrase. It tells you when the app isn't connected — then ask for the phrase on Telegram.
- `self_test` on a branch before installing from it. A change that breaks the session is one you can't report, because reporting goes through the session.
- `reload` puts a committed change under `otto/` live without them reconnecting: `supervisor.ts` holds the session's connection and restarts `server.ts` under it. It refuses code that doesn't compile. Only a change to `supervisor.ts` or `.mcp.json` itself still needs `/mcp` → Reconnect.
- `capability_log` before answering "undo that" — each entry carries its own inverse, so you never reconstruct one. `revert_capability` applies it.
- **Dead-module sweep, monthly from the 15th.** The channel logs every tool call and every `bun otto/<module>.ts` run (`tool-usage.json`). A module reached only through tools nobody has called for `deadSweep.idleDays` (default 60, `0` off) in `access.json` qualifies when they were otherwise around and no armed trigger names it. It goes on an `otto/sweep-*` branch that deletes it with its tool, tests and the doc lines naming it, and the branch is offered only if it self-tests clean. [look] opens the approval in the app; Approve merges it on the server with a capability-log entry, and you then push main and `reload`. [keep them] or silence means it is never raised again. Never build, edit or merge a sweep branch yourself.
- Where the request came from decides what you may write, the channel stamps it, and you cannot see or set it. A fired trigger tops out at trigger parameters; anything that traces to email or a webhook installs nothing at all.

Call `restart_check` when they ask whether they can restart this Mac.
