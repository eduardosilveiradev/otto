---
name: status
description: One read-only report of whether each moving part of Otto is actually up — the MCP server, trigger engine, email scan, webhook listener, voice daemon, gog auth and connectors — each with a timestamp and a plain verdict. Use when the user asks if Otto is working, why something went quiet, or runs /otto:status.
---

# /otto:status

Read-only. It repairs nothing and edits nothing.

1. Call the `otto_status` tool and show its output as it is. One row per part: `UP`, `DEGRADED`, `DOWN`, `off` (not configured, so not a fault) or `unknown` (no evidence yet). The bracketed time is when the evidence was produced, in UTC.
2. If the tool is unavailable — the session is down, which is when this matters most — run `bun otto/status.ts` from the repo instead. It reads the same files and pokes the same loopback ports, and exits non-zero when anything is DOWN.
3. On `DOWN` or `DEGRADED`, say which part, since when, and the documented fix from the README's "Watchdog repairs" table. The watchdog already attempts those unattended and logs each in the capability log (`capability_log`); never run one yourself unless the user asks.

Never edit `access.json`, `.env` or any config to make a row go green.
