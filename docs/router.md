# Model and effort routing

Routing is off by default. Set `router` in machine-local `~/.otto/state/access.json`:

```json
{
  "router": {
    "jobs": false,
    "messages": false,
    "classifier": "local-tier-classifier",
    "trivial": { "model": "opus", "effort": "medium" },
    "normal": { "model": "fable", "effort": "high" },
    "hard": { "model": "fable", "effort": "xhigh" }
  }
}
```

Merge this field into the existing access file; keep its other fields. Omit
`classifier` to use heuristics. The table above is the default; aliases resolve
to `claude-opus-5-5` and `claude-fable-5-2`. Automatic routing rejects `max`.

`classifier` is a trusted local shell command. It receives a classification
instruction and JSON-quoted input on stdin, and must write exactly `trivial`,
`normal`, or `hard` to stdout and exit successfully. Send diagnostics to stderr.
Use a wrapper around the installed local model, such as an MLX Gemma generate
command. Keep machine-specific commands and paths in the access file.

Classification has a 1.4-second deadline, leaving room within the 1.5-second
message budget. A timeout, error, or invalid answer kills the command's process
group and uses heuristics. After failure, calls use heuristics for one minute
before trying again. A cold model that cannot meet the deadline should use a
command that queries an already warm local model, or stay on the fallback.

`router-decisions.json` in the state directory retains the latest 200 decisions:
timestamp, kind, tier, model, effort, source (`model` or `heuristic`), and elapsed
milliseconds. It stores no prompt text. Check this file to measure the actual
classifier's latency on the machine; fixture timing does not measure MLX.

With `jobs` enabled, routing fills missing model and effort fields on `code_job`.
Explicit fields win. Below 25% of Claude's weekly window, a job without an
explicit model still defaults to `gpt-6.2-sol`. UI/design work never uses GPT;
at low quota it requires `override_low_limit: true` to use Claude. An explicit
Claude model, including Fable, also needs that override at low quota.
The optional `pace` block (README, Coding jobs) runs before this guard and
overrides the router's pick on the days it restricts.
T3's advertised model capabilities validate effort before a thread starts.
Jobs retain effort and show it alongside the model in cards and `code_jobs`.

With `messages` enabled, a hard owner message from the app, Telegram, or WhatsApp
gets a short `ultrathink` line in its injected content. This changes no main
session model. Forwards, untrusted app shares, reactions, and events such as
webhooks, emails and triggers do not get the line.

Before merging the `server.ts` change, the user must approve it. Before enabling
message routing in normal use, send a hard prompt through the app with
`router.messages` on and confirm in the session log that the turn ran at xhigh.
Tests verify injected text; they cannot prove that Claude treats a keyword
inside channel-injected content as a per-turn effort instruction.
