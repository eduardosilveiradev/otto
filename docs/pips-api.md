# Pips app API

The existing app token authenticates every route below (`Authorization: Bearer <token>`). Use the existing `/app` websocket and pairing flow. The authenticated owner can create and manage groups and pips directly. These app routes do not depend on the chat origin. Otto’s chat creation and group-renaming tools still require an untainted request the user typed; pip runners cannot use them or access the owner’s app token.

`app` always identifies Otto's original thread. Old websocket messages without `conversation_id`, `/app/history`, uploads, and the Telegram/WhatsApp paths retain their existing behavior. Telegram and WhatsApp never route to pips. With no pips, show the existing Otto thread and hide the conversation picker.

## Routes

All request bodies are JSON objects, at most 32 KiB. IDs are opaque strings; URL-encode them. Success is 200 unless specified. Errors use `{ "error": "explanation" }` when available: 400 invalid input, 401 invalid/revoked token, 404 unknown resource, 405 unsupported method, 413 oversized body, 503 storage or delivery unavailable (retry with the same message ID). Retry interrupted requests with the same client message ID.

| Method and route | Request | Response |
| --- | --- | --- |
| GET `/app/conversations` | None | `{conversations: ConversationRow[]}` including `app` |
| GET `/app/conversations/:id` | None | `ConversationRow` |
| GET `/app/conversations/:id/history` | `?limit=50&since=<ISO>`; limit 1–500 | `{messages: Message[]}`; ascending time; records strictly after `since`, then the last `limit` records |
| POST `/app/conversations/:id/messages` | `{id: "client-UUID", text: "@Fares check the flights"}` | `{message: Message}`; ID deduplicates resends within the conversation |
| POST `/app/conversations/:id/read` | Empty body allowed | 204; marks current conversation messages seen on all devices |
| POST `/app/conversations/:id/buttons` | `{button_id: "opaque-id"}` | First tap `{handoff: Handoff}`; repeat `{usedAt: ISO}` |
| GET `/app/conversations/search?q=flights` | Nonempty query, max 200 characters | `{results: [{conversation: ConversationRow, matches: Message[]}]}`; case-insensitive conversation name and message text; last 20 matching messages per conversation |
| POST `/app/groups` | `{name, members: [pipId]}` | `ConversationRow`; Otto is always a member |
| PATCH `/app/groups/:id` | `{name: string}`; nonempty, max 60 characters; unknown fields rejected | Updated `ConversationRow` |
| POST `/app/groups/:id/members` | `{pip_id: string}`; existing pip; unknown fields rejected | `ConversationRow`; current member is a no-op |
| DELETE `/app/groups/:id/members/:pipId` | None | `ConversationRow`; keeps the pip; removing Otto returns 400 |
| DELETE `/app/groups/:id` | None | 204; archives only a group; `app` and pip threads return 400 |
| POST `/app/pips` | `{name, job, instructions, solid, colour, tools, description?}` | `PipDetail`; same validation and exact name/job reuse as `create_pip` |
| GET `/app/pips/tools` | None | `{tools: [{id, label}]}`; the exact selectable creation allowlist |
| DELETE `/app/pips/:id` | None | 204; archives pip and its thread, removes group memberships and stops schedules; Otto/`app` return 400 |
| GET `/app/pips` | None | `{pips: PipDetail[]}` |
| GET `/app/pips/:id` | None | `PipDetail` |
| PATCH `/app/pips/:id` | Any subset of `name`, `job`, `instructions`, `description`, `schedules`, `paused`, `solid`, `colour`, `tools` | Updated `PipDetail`; unknown fields rejected |
| GET `/app/handoffs/:id` | None | `Handoff` |
| POST `/app/handoffs/:id/actions` | `{action: "retry"}` or `{action: "ask_otto"}` | `{handoff: Handoff, retry: Handoff|null}`; requires a failed handoff; repeated action deduplicates |

Archiving keeps records and history on disk but removes the archived conversation from conversation lists and search; archived pips also leave `/app/pips`. Group archiving leaves its pips untouched. Archived targets cannot receive new work or be added to groups. An already running turn may finish. Renaming, adding and removing each write a system line and publish `conversations_changed` plus `group_link`; adding a current member changes nothing. Group links in history reads use the current name and membership. Old app transports and websocket frames keep their existing meanings.

Pip names are nonempty strings up to 60 characters, jobs up to 200, instructions/description up to 8000. `solid` is a pip solid (never `sphere`), `colour` is `#RRGGBB`, and `tools` must contain only IDs from `/app/pips/tools`. Shared memory and pip activity/handoff tools remain automatically included. PATCH uses the same appearance/tool validation as creation. App creation rejects unknown fields.

An unaddressed group message goes to Otto first. Otto replies with `conversation_id`, then uses `pip_handoff` to bring in helpers. `@name` routes to matching group members, case-insensitively; `@Otto` routes to Otto. Multiple pip mentions fan out. An unknown mention returns 400 without storing the message. A pip's own thread defaults to that pip. A pip can ask another member or ask Otto through `pip_handoff`; the server stamps the actual sender, never a model-supplied identity.

Use globally unique client message IDs. New thread messages and routing work are saved together before delivery. Pending delivery to Otto survives a restart. Delivery may replay after a crash under the same ID, as on the original app transport; clients upsert by ID.

For microphone dictation, transcribe on the client and send the text to the selected conversation; this server has no dictation endpoint. Capture, waveform and editing stay on the client. The `/app/voice` audio-note upload and `/app/photo` belong to `app`; there are no group audio-note or photo attachments.

## Payloads

Times ending in `At`, message `ts`, and handoff times are ISO-8601 UTC strings unless noted. Display them in the user's current timezone. `nextWakeAt`, schedule `nextRun`, and `awakeUntil` are epoch milliseconds; schedule `tz` is an explicit IANA timezone.

```ts
type State = 'rest' | 'working' | 'needs' | 'asleep' | 'gpt' | 'failed'
type Member = {
  id: string                         // 'otto' or a pip id
  name: string
  solid: 'sphere' | 'rounded-cube' | 'capsule' | 'gumdrop' | 'gem' | 'drum' | 'diamond'
  colour: string                     // #RRGGBB; sphere belongs only to Otto
  state: State
  activity: string | null            // up to 160 characters
  buttons: PipButton[]
}
type ConversationRow = {
  id: string
  kind: 'otto' | 'pip' | 'group'
  name: string
  members: string[]                  // includes 'otto'; user is implicit
  createdBy: 'otto'
  lastMessage: Message | null
  unread: number                     // unseen non-user messages, including system lines
  readAt: string | null              // shared across phone and desktop
  memberStates: Member[]             // complete faces, badges and activity
  activity: Member[]                 // members whose live activity is nonempty
  nextWakeAt: number | null          // pip threads; null for groups/Otto/paused pips
}
type PipButton = {
  id: string
  label: string                      // up to 40 characters
  ask: string                        // exact continuation the user approves
  usedAt?: string
}
type GroupLink = {
  id: string
  name: string
  members: Member[]                  // blobbed group picture
  memberList: string                 // ready-to-display one-line names
}
type Message = {
  id: string
  conversation_id: string
  sender: 'user' | 'otto' | string    // other strings are pip ids
  kind: 'text' | 'system' | 'edit' | 'reaction' // last two are legacy app patches
  text: string
  ts: string
  handoff_id?: string                // tap the system line for detail
  pip_id?: string                    // made/added lines open this pip's sheet
  group?: GroupLink                 // tap opens group.id
  buttons?: PipButton[]
  read?: boolean                    // incoming user text has reached its recipient
  readAt?: string
}
```

`app` history adapts the existing history, retaining its optional files, voice, cards, buttons, reactions, edit patches, and other extras. Continue handling those existing fields. A patch row is not a new bubble. The old `/app/history` response stays an array in its original format. New pip/group messages use `conversation_message` events and never become ordinary messages in the old app thread.

Otto's automatic group announcement always carries `group: GroupLink`; it is not an optional text-only convention. Creating a group stores the announcement in `app` and a system line in the new group. Adding members updates that link's membership in new history reads and emits `group_link`. A later `reply(group_id: ...)` can carry the same payload. Clients render the link as the compact group picture, name, and `memberList` shown in the mockup.

```ts
type Schedule = {
  id: string                         // server-assigned
  name: string                       // 'Morning route check'
  label: string                      // 'Weekdays 7:30'
  schedule: string                   // '30 7 * * 1-5'
  tz: string                         // 'Europe/Berlin'
  ask: string                        // work to perform
  nextRun?: number                   // epoch ms
}
type PipDetail = {
  id: string
  name: string                       // up to 60 characters
  job: string                        // one line, up to 200 characters
  instructions: string              // up to 8000 characters
  description: string               // longer sheet copy, up to 8000 characters
  tools: string[]
  model: string                      // configured Claude model, gpt-6.2-sol or gpt-6.1-sol
  solid: Member['solid']
  colour: string
  paused: boolean
  createdBy: 'otto'
  createdAt: string
  lastActiveAt: string | null
  state: State
  activity: string | null
  buttons: PipButton[]
  schedules: Schedule[]
  nextWakeAt: number | null
  canReach: {id: string, name: string, sharedWithOtto: boolean}[]
  sharedWithOtto: true
  runsOn: {
    model: string                    // runner selected for current/next work
    requestedModel: string           // configured model
    available: boolean              // runner supported; startup errors fail the handoff
    schedulesHeld: false            // low Claude capacity now uses Codex
    reason: string
    claudeReturnsAt: string | null   // known weekly reset; format locally
  }
  retireSuggested?: boolean          // list responses: unused for at least 30 days
  usage: { runs: number, tokens: number } // all started runs; observed input/output/cache tokens
  wakes: {
    id: string                       // handoff ID, including each retry
    trigger: 'handoff' | 'schedule' | 'owner_message'
    from: string
    ask: string
    conversation: string
    askedAt: string
    startedAt?: string
    endedAt?: string
    outcome: 'asked' | 'answered' | 'failed'
    model?: string
    tokens: number
    error?: string
  }[]
  codexSessionId?: string             // separate Codex session; runtime metadata
  activeModel?: string                // last admitted model; runtime metadata
  sessionId: string                  // opaque Claude runtime metadata; do not render
  sessionUsed: boolean               // runtime metadata
  awakeUntil?: number                // runtime lease expiry, not a scheduled wake
}
```

PATCH schedules replaces the whole list (max 10), accepts `{name,label,schedule,tz,ask}`, and assigns fresh schedule IDs and next times. `[]` clears schedules. The server evaluates cron with the same `computeNextRun`/Croner engine used by Otto's triggers, including timezone/DST handling. A due schedule wakes its pip in its own thread, without a user message, using Codex when fresh Claude weekly capacity is below 25%. Missed intervals coalesce to one wake; a pip already handling a request does not acquire another scheduled request. Pause suppresses future schedule dispatch and new wakes; an already admitted/running turn may finish. No scheduled turn can create a group or pip.

Pips can select `mcp__plugin_otto_otto__code_job` (Coding jobs (start)), `mcp__plugin_otto_otto__code_jobs` (Coding jobs (read)), and `mcp__plugin_otto_otto__code_job_answer` (Coding jobs (answer or follow up)) from `/app/pips/tools`. `code_job_answer({id,text})` uses the existing jobs answer path: it answers a pending T3 question, otherwise sends the thread a follow-up. A pip can answer only jobs it started. It can relaunch failed work with a new `code_job` call.

Starting or answering a coding job requires that selected tool and a host-stamped owner message, owner button, or untainted Otto handoff. Email, webhook, trigger, scheduled and pip-to-pip wakes cannot start or steer coding jobs. Retries retain the original provenance; old wakes without a stamp fail closed. A job event for a pip's own coding job is an authorized continuation of that task. The runner cannot supply or change this permission. Pip jobs use the existing low-limit selection and guard: below 25% of the fresh Claude weekly window, ordinary jobs default to `gpt-6.2-sol`; pips cannot override the Claude guard.

Coding job records retain the starting `pipId`. Review, input, failed, stopped and recent done attention events queue deduplicated handoffs in that pip's own thread. Their replies stay there and do not wake Otto. Otto-started jobs retain their existing delivery. If the starting pip was deleted, events fall back to Otto. A paused pip holds queued updates under the normal wake rules. Pips have no merge tool; the owner merges from the app.

`Can reach` contains readable names for actual allowed tools, such as Web search, Shared memory, Calendar and inbox summary, and Places and routes. It does not imply a full Calendar or Gmail connector in the runner. Shared memory is always available through the same recall/remember tools as Otto. A pip runs as external content, so `remember` takes notes (fact, loop, saved, write) but refuses durable user, feedback, project and reference memories. Pips have no shell, arbitrary file-write, payment, mail-send or merge tools. Approval buttons return the choice to the pip; it asks Otto to execute outward work under Otto's existing approval rules. A Merge button does not itself merge a PR.

```ts
type Handoff = {
  id: string
  origin?: 'user-typed' | 'model-authored' | 'triggered' | 'external-content' // host stamp
  jobEvent?: string                  // deduplication ID for a coding job continuation
  from: string                       // 'user' for the owner's own message, @mention or button tap; otherwise 'otto' or the requesting pip id
  to: string                         // pip id, or 'otto' for a pip escalation
  conversation: string
  ask: string
  reply?: string
  model?: string                     // actual runner model
  tokens?: number                    // observed usage for this attempt
  status: 'asked' | 'answered' | 'failed'
  askedAt: string
  startedAt?: string                 // supervisor launched runner within wake deadline
  endedAt?: string
  jobId?: string
  messageId?: string                 // user message that prompted a direct pip wake
  error?: string
  relayedTo?: 'otto'
  toldOttoAt?: string                // result reached Otto's orchestrator, or escalation delivered
  toldUserAt?: string                // reply stored in the user-visible thread
  actions?: {
    action: 'retry' | 'ask_otto'
    at: string
    handoffId?: string               // new attempt for retry; original remains failed
  }[]
}
```

A result from a pip is relayed by Otto's server into the requested conversation. Unless `from` is `user` or the handoff carries a coding job event, it is also journaled to Otto's main session as untrusted data; a handoff the owner started stays in its thread and has no `relayedTo` or `toldOttoAt`, even if it fails, until Ask Otto is used. Relay times describe server delivery, not proof that a model or person read the result. A pip asking Otto has `toldOttoAt` when its queued request is delivered; Otto's `reply(handoff_id: ...)` completes that record and sets `toldUserAt`.

If no runner starts within 30 seconds of `askedAt`, the attempt fails and a system line states that nothing was delivered. The queued job is cancelled, and the supervisor independently refuses an expired wake. Retry creates a fresh handoff/deadline with the same `from` and links it from the original's actions. Ask Otto records that choice and forwards the original ask to Otto with conservative provenance. The two actions are each idempotent; repeated retries of an already retried attempt return the same new handoff.

## Websocket contract

Connect as today to `/app` with the app token. Existing `hello`, `message`, `ack`, `read`, typing, job and approval frames keep their meanings. Unknown frame types remain safe for old builds.

Send a message with `{type:"message", conversation_id:"group-id", id:"client-UUID", text:"@Fares check flights"}`. For `app`, omit `conversation_id` to use the original transport. New conversation sends receive the existing `{type:"ack", id}` after durable acceptance. Errors return `{type:"conversation_error", conversation_id, id, error}` without ack; correct invalid input before retrying.

Send `{type:"pip_button", conversation_id, id:"client-operation-UUID", button_id}` for a pip button, or use HTTP. Send `{type:"conversation_read", conversation_id, id:"client-operation-UUID"}` when a conversation becomes visible. The latter clears unread dots on every device; it does not claim that Otto read an incoming user message.

| Server frame | Payload and handling |
| --- | --- |
| `conversation_message` | `{type,message: Message}`; upsert by `(conversation_id,id)`, including receipt updates |
| `conversation_read` | `{type,conversation_id,readAt}`; update shared seen watermark and unread dots |
| `conversations_changed` | `{type}`; invalidate/refetch conversation rows and pip details as needed |
| `pip_state` | `{type,pip: Pip}`; creation/edit snapshot; refetch detail for computed fields |
| `pip_states` | `{type,pips: PipDetail[]}`; reconciled lifecycle snapshots |
| `pip_activity` | `{type,conversation_id,pip: Member}`; update live line, buttons and face; the activity also appears in conversation list GETs |
| `handoff_updated` | `{type,handoff: Handoff}`; refresh an open sheet |
| `group_link` | `{type,group: GroupLink}`; replace matching compact links and group picture membership |

Events are invalidations/updates, not a replay log. After reconnect, GET conversation rows, the selected conversation's history, and open pip/handoff details. Pip activity and button state persist on disk. Existing app frames continue to supply live messages in `app`; new clients normalize them to `conversation_id:"app", sender:"otto"` (or `user` for `echo`). Use the original `read` IDs for app read labels; new conversation user receipts also arrive as `conversation_message` upserts.

## Runtime and configuration

`access.json` may contain `pips: {idleMinutes:10,maxAwake:3,maxTotal:12}`. Valid ranges are 1–1440 minutes and 1–100 for each cap; invalid values use defaults. Clients do not write this configuration. Pips, conversations, messages, read marks, outbox and handoffs live in `pips.json`. Runner/supervisor records remain in the existing `jobs.json`.

A pip leases an awake slot while working and for the idle window after a completed turn. Its runner exits between turns; separate Claude and Codex session IDs and a stable scratch directory retain context. Codex returns its session ID in `thread.started`; later Codex turns resume that ID. Switching back to Claude resumes the previous Claude session. On expiry, state becomes `asleep` and the slot is free. Restarts reconcile detached supervisors and finished jobs from disk. A pip runs one turn at a time; excess requests queue, subject to the 30-second wake deadline. The pip cap is separate from Otto's ordinary delegated-job cap.

States: `rest` is an awake idle Claude pip; `working` is queued/admitted or running Claude work; `needs` means a choice needs attention; `asleep` holds no awake slot; `failed` records an unsuccessful attempt. At less than 25% remaining in a fresh Claude weekly window, new wakes use `gpt-6.2-sol` through `codex exec`, including schedules, owner messages, buttons and retries. These pips emit `gpt` and a model-switch system line. An already admitted turn keeps its runner. New wakes return to the configured model when capacity recovers; a pip configured explicitly for `gpt-6.2-sol` (or `gpt-6.1-sol`) stays on Codex. `runsOn.model` reports the selected runner, `requestedModel` preserves the configuration, and `claudeReturnsAt` supplies the observed weekly reset when known.

The Codex child ignores user configuration and rules, uses a read-only sandbox with shell execution disabled, and loads only Otto's selected MCP tools. Its MCP server receives the same pinned pip identity and conservative origin as the Claude child. Outward actions and pip creation remain unavailable. Native web search is enabled only when WebSearch or WebFetch was selected. Claude's Read/Grep/Glob built-ins are unavailable on the Codex path.

`usage` and `wakes` come from durable handoffs, so job pruning does not erase them and reconciliation does not count a run twice. Runs count runner launches (`startedAt`), not queued requests that never launched. Tokens are the usage observed from the runner, including failed turns when usage was reported; a process killed before it reports usage can undercount. Wake outcomes use the handoff status and retain the ask, trigger, model and error.

Results, their visible conversation messages and pending Otto notifications are committed together. The outbox retries failed notifications after restart using stable IDs. Otto's inbound journal deduplicates acceptance of those IDs and owns receipt recovery after acceptance. Transport notifications can replay when receipt was not confirmed; clients upsert message IDs. This guarantees one stored reply and one logical handoff, rather than exactly-once model execution. A dead supervisor, elapsed wall clock, missing CLI, failed spawn, runner error or unsuccessful exit marks the handoff failed and keeps Retry / Ask Otto available.

Chat tools are `list_pips`, `create_group`, `rename_group(group_id, name)`, `create_pip`, `add_to_group`. Group renaming uses the same origin guard as creation. `create_pip` reuses exact matching name/job entries; Otto evaluates broader job fit using the list first. `pip_handoff` routes work; `pip_activity` reports live work or Otto's per-conversation activity. Creation checks the server's effective origin and pinned pip identity, so email, webhooks, triggers, tainted turns and pip runners cannot create helpers. Stale pips are suggested for retirement, never automatically deleted.

## Approved mockup coverage checklist

This checklist covers the light and dark variants equally. Layout, glass, typography, separators, navigation transitions, keyboard, device status chrome and localization are client-only.

| Screen | Visible element | Source |
| --- | --- | --- |
| Conversations | Otto pinned at top; hide this screen when only Otto exists | `GET /app/conversations`; `kind:"otto"`; client layout |
| Conversations | Names, preview text, sender prefix, timestamp/Yesterday/Monday | Row `name`, `lastMessage.text`, `.sender`, `.ts`; resolve sender from `memberStates`; client date formatting |
| Conversations | Unread dots; needs-first ordering | `unread`; `memberStates[].state`; client sort |
| Conversations | Single faces and blobbed group faces, needs/working/GPT/asleep badges | `memberStates[].solid/colour/state`; client renderer; GPT exception above |
| Conversations | “Reading 12 new emails”, typing dots | `activity[].activity/state`, `pip_activity`; literal content is reported by the pip |
| Conversations | “Back at 7:00 tomorrow” | `nextWakeAt`, pip schedule `tz`; client formatting |
| Conversations | Search bar and results | `GET /app/conversations/search?q=...` |
| Otto's thread | Otto avatar/name capsule, back arrow, phone button | `app` row/member; navigation and existing call UI are client-only |
| Otto's thread | Date stamps, bubbles, Read, composer, mic | `/app/history` or normalized conversation history; existing app `read`; send route; client-side dictation plus send; capture UI is client-only |
| Otto's thread | “Inbox asked Planner…” / “Otto asked Code…” small lines | Message `kind:"system"`, `.text`, `.ts`, `.handoff_id`; GET handoff on tap |
| Group chat | Group name, blobbed header picture, back arrow | Conversation row `name/memberStates`; client layout |
| Group chat | Sender labels, text, time stamps, user bubbles | History `sender/text/ts`; resolve names from members/pip detail |
| Group chat | Model-switch line and GPT badge | System message/state contract; Codex runs new wakes below the weekly threshold |
| Group chat | Handoff line, typing line, @Inbox composer | `handoff_id`; row `activity`; `pip_activity`; text routing with `@name` |
| Handoff | Two faces and “Otto to Code”/“Planner to School” | `from/to`; resolve `Member` or `GET /app/pips/:id`; `from: 'user'` is the owner and has no pip record |
| Handoff | Ask, answer, date/time | `ask/reply/askedAt/endedAt` |
| Handoff | “Code told Otto at 8:13, and Otto told you” | `relayedTo/toldOttoAt/toldUserAt`; server relay semantics described above |
| Handoff | Open Code | `to` is Code's own conversation ID; client navigation |
| Failed handoff | Failed system line, sleepy/failed face, ask and date | Message `.handoff_id`; handoff `status/error/ask/askedAt`; member state |
| Failed handoff | “Didn't wake within 30 seconds, so nothing was sent” | `Handoff.error`; deadline enforced in host and supervisor |
| Failed handoff | Retry / Ask Otto to handle it | POST handoff `/actions`; `actions[]` audit and retry link |
| Otto makes a group | Typed ask, Read, brief reply and explanatory bubbles | Original `app` transport/history/receipts; Otto's normal replies |
| Otto makes a group | Mandatory compact group picture, title and member list | Announcement `group: {id,name,members,memberList}`; group_link updates |
| A new group | Started/made/added lines with times | System `text/ts`; `pip_id` opens details for made/added entries |
| A new group | Planner/Fares/Stays replies; “Comparing Friday fares” | Message `sender/text`; conversation `activity`, websocket `pip_activity` |
| Pip details | Face/name, one-line job, longer description | `GET /app/pips/:id`: `solid/colour/state/name/job/description`; editable fields via PATCH |
| Pip details | Named schedules and human time labels | `schedules[].name/label/schedule/tz/nextRun`; PATCH replaces schedules |
| Pip details | Can reach / Shared with Otto | `canReach[].name/sharedWithOtto`, top-level `sharedWithOtto`; actual available tools only |
| Pip details | Runs on / reason / “Back on Monday” | `runsOn.model/available/reason/claudeReturnsAt`; client date formatting; actual selected model and observed Claude reset |
| Pip details | Pause pip | `paused`; PATCH `{paused:true}`; resume with false |
| Mac conversations | Otto tree, pip branches, Groups, face badges | Conversation `kind/members/memberStates`; client tree layout |
| Mac conversations | Today, Jobs count, Triggers, Usage, Session weekly meter | Existing `/app/dash/today`, `/app/jobs`, `/app/dash/triggers`, `/app/dash/usage`, `/app/dash/session`; existing navigation is client-only |
| Mac conversations | Thread header/bubbles/date stamps/handoff lines/composer | Same `app` history and handoff APIs as phone |
| Mac group chat | Sidebar, group header, sender labels, text, timestamps | Same conversation rows/history/member states as phone |
| Mac group chat | “Inbox sent the notes to Code” | Stored handoff system line and detail; exact wording supplied by the orchestration |
| Mac group chat | “Working on” list, Otto/Code/Inbox lines | Row `activity[]` including Otto, pip detail `activity`; websocket `pip_activity` |
| Mac group chat | Merge / Hold | Activity or message `buttons[]`; POST conversation `/buttons` or `pip_button` frame; server routes back to that pip, never directly merges |
| The faces | Seven solids, colours, six poses, blink, sleep z, dots, attention and switch badges | `Member.solid/colour/state`; geometry, eyes, compositing and animation are client-only; sphere reserved for Otto; gpt marks Codex work |
| Live renderer | Face/pose pickers, blink button, drag rotation, fallback image | Client-only graphics demo, using the same member appearance/state contract |

Known limits for the client: no group audio-note/photo attachments; no full Gmail/Calendar connector in pip runners. Client-side dictation works for all conversations. Outward actions are routed to Otto for approval and execution. Face rendering and native call UI belong to the app.
