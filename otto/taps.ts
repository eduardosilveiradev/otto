/**
 * Taps the server carries out itself rather than handing to the session.
 *
 * These are the button taps whose effect is the server's own state: an install, a
 * schedule change, a device revoked, an offer settled. Routing them here rather than
 * through the session is how the tap stays a tap: `classify` needs proof of kind
 * `tapped`, and only the code that received the callback can honestly say one happened.
 *
 * Split out of server.ts, which still owns the callback handlers (Telegram, the app,
 * WhatsApp) and calls handleCapabilityButton from each of them.
 */
import { TAP as NEWSLETTER_TAP, applyTap as newsletterTap } from './unsubscribe.ts'
import { randomBytes } from 'crypto'
import { rmSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { revokeAppToken } from './apptokens.ts'
import { dispatchTap, tapMatch, wasOffered, type Offered, type Tap } from './dispatch.ts'
import { TAP_RE as BACKOFF_TAP_RE, applyTap as applyBackoffTap } from './backoff.ts'
import { parseCancelTap, loadCancelState, settleCancelNudge, saveCancelState } from './cancelguard.ts'
import { recordDecline } from './capindex.ts'
import { appendEntry, entryId } from './changelog.ts'
import { loadSweepState, saveSweepState, sweepSummary } from './deadsweep.ts'
import { duBytes } from './disk.ts'
import { planInstall } from './forge.ts'
import { github } from './github.ts'
import { parseKitTap, loadKitState, KEEPINTOUCH_FILE, applyKitTap, saveKitState } from './keepintouch.ts'
import { loadLandlord, landlordTap, realDeps as landlordDeps, saveLandlord } from './landlord.ts'
import { loadDietState, saveDietState, dietPaths, renderDiff } from './memdiet.ts'
import { dirForScope } from './memory.ts'
import { applyCategoryTap } from './money-category.ts'
import { MONEY_FILE, loadMoney, saveMoney } from './money.ts'
import { pairingButton } from './pairing.ts'
import { RESUME_RE, resumeWorkspace, parachuteConfig, loadParachute } from './parachute.ts'
import { loadPeople, PEOPLE_FILE, findPerson, savePeople } from './people.ts'
import { applyTap as applyPulseTap, loadPulse, savePulse, TAP_RE as PULSE_TAP_RE } from './pulse.ts'
import { markReelTried } from './reels.ts'
import { settleReturnTap } from './returns.ts'
import { rulebookCard, formatRulebook, findRule, deleteRule } from './rulebook.ts'
import { CLEAR_ORPHANS_RE, clearOrphans, loadLoadState, QUIT_RE, quitProcess } from './runaway.ts'
import { computeNextRun } from './schedule.ts'
import { type Proof, type Origin, classify, tierForPath } from './selfedit.ts'
import { setQuietWindow } from './settings.ts'
import { TAP_RE, applyTap, loadSleep, saveSleep } from './sleep.ts'
import { TAP as SPEND_WEEK_TAP, queueBacklog } from './spendweek.ts'
import { stalePrTap } from './stalepr.ts'
import { loadState as loadReelState } from './statefile.ts'
import { loadNotes, saveNotes, upsertNote } from './store.ts'
import { routeReminderTap } from './travelroute.ts'
import { loadUpdates, updatesTap, saveUpdates, TAP_RE as UPDATES_TAP_RE } from './updates.ts'
import {
  selfEditEnabled, SELF_EDIT_OFF,
  APP_DEVICE_OFFERS_FILE, CANCEL_NUDGE_FILE, CAPABILITY_LOG, DIET_FILE, FORGE_DIR, LANDLORD_FILE, NOTES_FILE, PARACHUTE_FILE, REPO_ROOT, RUNAWAY_FILE, SLEEP_FILE, STATE_DIR, STATIC, SWEEP_FILE, TAP_OFFERS_FILE, type Trigger, UPDATES_FILE, appSockets, codeJobs, deliverQueued, installCapability, loadAccess, loadDraft, loadRuntimeState, loadTriggers, raiseApproval, readNotes, repoSha, routeReply, saveAccess, saveRuntimeState, saveTriggers, sendServerMessage, stampOrigin, writeFilesCapturingBefores, writeNotes,
} from './server.ts'
import { CLAUDE_PROJECTS, currentRules, git, keepSweep, landlordProtect, logRuleChange, protectedPids } from './chores.ts'

type TapCtx = { data: string; chat_id: string }

/** Rows with no state of their own: the exact data must be one sendServerMessage (or the pulse cards tool) recorded. */
const SENT: Offered<TapCtx> = { check: (_, { data }) => wasOffered(TAP_OFFERS_FILE, data), stale: 'That button is no longer on offer.' }

/**
 * Every tap the server settles itself, keyed by verb. Each row says how the server
 * knows it offered that button (dispatch.ts, `Offered`); a row whose run returns
 * null leaves the tap to the session, as does data no row matches.
 */
const TAPS: Record<string, Tap<TapCtx>> = {
  newsletter: {
    match: NEWSLETTER_TAP,
    offered: { inRun: 'newsletterTap checks the persisted offer id and sender outcomes before acting' },
    run: (_, { data }) => newsletterTap(STATE_DIR, data),
  },
  'revoke stale device': {
    match: /^revoke stale device ([a-f0-9]+)$/,
    offered: { check: m => loadReelState<string[]>(APP_DEVICE_OFFERS_FILE, () => [], Array.isArray).includes(m[1]), stale: 'That device was not offered for revocation.' },
    run: m => revokeAppToken(m[1]) ? 'Device access revoked.' : 'That device was already revoked.',
  },
  'return keep': {
    match: /^return keep ([a-f0-9]{8})$/,
    // claimReturnPrompts stamps returnAskedOn on the purchase as it sends the [keep] button.
    offered: { check: m => !!loadMoney(MONEY_FILE).find(r => r.id === m[1])?.purchase?.returnAskedOn, stale: 'That purchase was not offered for return.' },
    run: (_, { data }) => {
      const tap = settleReturnTap(MONEY_FILE, data)
      return tap ? (tap.choice === 'keep' ? 'Keeping it.' : 'Already marked for return.') : null
    },
  },
  'money category': {
    match: /^money category /,
    offered: { inRun: 'applyCategoryTap: the offer note it names must still exist' },
    run: (_, { data }) => {
      const records = loadMoney(MONEY_FILE)
      const notes = readNotes()
      const line = applyCategoryTap(records, notes, data)
      if (line !== null) {
        writeNotes(notes)
        saveMoney(MONEY_FILE, records)
      }
      return line
    },
  },
  'route remind': {
    match: /^route remind /,
    offered: { inRun: 'routeReminderTap: the offer must still be in route-offers.json' },
    run: (_, { data, chat_id }) => {
      const routeTap = routeReminderTap(data)
      if (routeTap === undefined) return null
      if (!routeTap) return 'That route reminder has expired. Check the route again.'
      const triggers = loadTriggers()
      if (!triggers.some(t => t.id === routeTap.id)) {
        routeTap.action += ` Reply to chat_id ${JSON.stringify(chat_id)} with priority urgent.`
        triggers.push(routeTap)
        saveTriggers(triggers)
      }
      return `Reminder set for ${routeTap.schedule} (UTC).`
    },
  },
  'reel tried': {
    match: /^reel tried ([a-f0-9]{8})$/,
    offered: SENT,
    run: m => {
      const notes = loadNotes(NOTES_FILE)
      if (!markReelTried(notes, m[1])) return 'That reel is no longer saved.'
      saveNotes(NOTES_FILE, notes)
      return 'Marked tried.'
    },
  },
  // Dashboard pairing taps resolve in process; the session never sees a nonce.
  pair: {
    match: /^pair /,
    offered: { inRun: 'pairingButton: the nonce must match a pending pairing' },
    run: (_, { data }) => pairingButton(data),
  },
  sleep: {
    match: TAP_RE,
    offered: { inRun: 'sleep.ts applyTap: only the window the server has pending' },
    run: (_, { data }) => handleSleepButton(data),
  },
  'stale pr': {
    match: /^\s*(merge stack|merge PR|close PR) /,
    offered: SENT,
    run: (_, { data }) => stalePrTap(github.run, data),
  },
  'spend week': {
    match: SPEND_WEEK_TAP,
    offered: { inRun: 'queueBacklog: this week’s picks, before the week resets' },
    run: () => queueBacklog(STATE_DIR, input => codeJobs.start(input), Date.now()),
  },
  backoff: {
    match: BACKOFF_TAP_RE,
    offered: { inRun: 'backoff.ts applyTap: only the offer pending for the schedule the trigger still has' },
    run: (_, { data }) => handleBackoffButton(data),
  },
  pulse: {
    match: PULSE_TAP_RE,
    offered: SENT,
    run: (_, { data }) => {
      const pulseTap = applyPulseTap(loadPulse(), data)
      if (!pulseTap) return null
      savePulse(pulseTap.state)
      return pulseTap.line
    },
  },
  'quit pid': {
    match: QUIT_RE,
    offered: { inRun: 'quitProcess: only a pid and start time this server offered' },
    run: (_, { data }) => handleQuitButton(data),
  },
  'clear orphans': {
    match: CLEAR_ORPHANS_RE,
    offered: { inRun: 'clearOrphans: only an orphan set this server offered' },
    run: (_, { data }) => handleQuitButton(data),
  },
  updates: {
    match: UPDATES_TAP_RE,
    offered: { inRun: 'updatesTap: only the list on offer now' },
    run: (_, { data }) => handleUpdatesButton(data),
  },
  landlord: {
    match: /^(evict|keep) landlord /,
    offered: { inRun: 'landlordTap: only the list on offer now' },
    run: (_, { data }) => handleLandlordButton(data),
  },
  resume: {
    match: RESUME_RE,
    offered: { inRun: 'resumeWorkspace: only the note last sent' },
    run: (_, { data }) => handleResumeButton(data),
  },
  'check-ins': {
    match: /^\s*(snooze|stop) check-ins with /,
    offered: SENT,
    run: (_, { data }) => {
      const kitTap = parseKitTap(data)
      if (!kitTap) return null
      const people = loadPeople(PEOPLE_FILE); const state = loadKitState(KEEPINTOUCH_FILE)
      const r = applyKitTap(people, state, kitTap, Date.now(), n => findPerson(people, n))
      if (!r) return null
      if (r.peopleChanged) savePeople(PEOPLE_FILE, people)
      if (r.stateChanged) saveKitState(KEEPINTOUCH_FILE, state)
      return r.line
    },
  },
  'review rulebook': {
    match: 'review rulebook',
    offered: SENT,
    run: (_, { data, chat_id }) => handleRulebookButton(data, chat_id),
  },
  'delete rule': {
    match: /^delete rule ([a-f0-9]{8})$/,
    offered: SENT,
    run: (_, { data, chat_id }) => handleRulebookButton(data, chat_id),
  },
  'view diet': {
    match: /^view diet (\d{4}-\d{2})$/,
    offered: { check: m => loadDietState(DIET_FILE).runs.find(r => r.month === m[1])?.status === 'offered', stale: 'that one is already settled' },
    run: m => dietButton(m[1]),
  },
  sweep: {
    match: /^(look|keep) sweep ([a-f0-9]{8})$/,
    offered: { check: m => loadSweepState(SWEEP_FILE).sweeps.find(r => r.id === m[2])?.status === 'offered', stale: 'that one is already settled' },
    run: m => sweepButton(m[1] as 'look' | 'keep', m[2]),
  },
  forge: {
    match: /^(install|tweak|drop) forge ([a-f0-9]+)$/,
    offered: { inRun: 'the draft must still be on disk under its id' },
    run: (m, { data }) => selfExtensionTap(m, data),
  },
  repetition: {
    // The drop button spells out "; never offer it again" after the id, so this
    // cannot anchor on the id: anchoring is what made every no fall through to
    // the session, which reacted 👍 and left no decline on disk to suppress the
    // next offer. Only the leading verb and id are load-bearing.
    match: /^(arm|drop) repetition ([a-z0-9-]+)\b/,
    offered: { inRun: 'arm needs the miner’s own note; drop only records a decline' },
    run: (m, { data }) => selfExtensionTap(m, data),
  },
  capability: {
    match: /^(arm|decline) capability ([a-z0-9-]+)$/,
    // Only a capability the server surfaced (recordMention) can be declined from a tap.
    offered: { check: m => Object.hasOwn(loadRuntimeState().surfaceState?.mentioned ?? {}, m[2]), stale: 'That capability was not offered.' },
    run: (m, { data }) => selfExtensionTap(m, data),
  },
}

/**
 * Taps that the server carries out itself rather than handing to the session.
 *
 * Routing them here rather than through the session is not an optimisation — it is
 * how the tap stays a tap: `classify` needs proof of kind `tapped`, and only the code
 * that received the callback can honestly say one happened. A session asked to
 * report "the user tapped it" is a session that can be talked into saying so.
 *
 * Returns the line to show the user, or null when this is an ordinary button that
 * belongs to the session.
 */
export function handleCapabilityButton(instruction: string, chat_id: string): Promise<string | null> {
  return dispatchTap(TAPS, instruction, { data: instruction, chat_id })
}

/**
 * True when a tap on this data would reach a row above. A session-written button or
 * card action must never carry it: the label is the session's, so "Thanks" could
 * hide a real offer's `delete rule <id>`. The app trims before dispatch, so both count.
 */
export function isServerTap(data: string): boolean {
  return Object.values(TAPS).some(t => tapMatch(t, data) || tapMatch(t, data.trim()))
}

/** The self-extension buttons whose payload is an install: forge drafts, repetition triggers, capability offers. */
async function selfExtensionTap(m: RegExpExecArray, instruction: string): Promise<string | null> {
  const [, verb, id] = m
  const kind = instruction.split(' ')[1]
  // A tap is the user, and it resets whatever the previous turn had read.
  stampOrigin({ kind: 'button' })
  const proof: Proof = { kind: 'tapped', buttonData: instruction }

  if (kind === 'forge') {
    const draft = loadDraft(id)
    if (!draft) return `that draft is gone (${id}) — forge it again if you still want it`
    if (verb === 'drop') {
      try { Bun.spawnSync(['git', 'branch', '-D', draft.branch], { cwd: REPO_ROOT }) } catch {}
      try { rmSync(join(FORGE_DIR, `${id}.json`)) } catch {}
      return null   // a 👍 is the whole answer; let the session react
    }
    if (verb === 'tweak') return null   // the session reloads it and asks the user what to change
    if (!selfEditEnabled()) return SELF_EDIT_OFF
    // Install. The origin is the one recorded when the draft was made, never the
    // tap's: a draft written under the influence of an email is not laundered by
    // the user tapping a button whose label that same email inspired.
    const request = draft.request ?? { text: draft.claim, origin: 'model-authored' as Origin, at: draft.createdAt }
    const { entry } = planInstall(draft, request, proof, { verdict: { grade: 'install', line: '', evidence: [] }, ...(repoSha() ? { sha: repoSha() } : {}) })
    writeFilesCapturingBefores(draft.files.map(f => ({ path: f.path, content: f.content })))
    appendEntry(CAPABILITY_LOG, entry)
    try { rmSync(join(FORGE_DIR, `${id}.json`)) } catch {}
    return `installed: ${draft.title}. undo with capability id ${entry.id}. live after /reload-plugins`
  }

  if (kind === 'repetition') {
    // A no is recorded before anything else can fail. The offer note ages out
    // long before the user's opinion does, and a decline that depends on
    // finding it is a decline the miner gets to ask again next week.
    if (verb === 'drop') {
      const notes = readNotes()
      upsertNote(notes, { kind: 'fact', text: `declined the repetition suggestion ${id}`, tags: ['repetition-declined', `repetition:${id}`] })
      writeNotes(notes)
      return null
    }
    // Notes written before the `repetition:<id>` tag existed carry the bare id.
    // Only the miner's own note (kind saved, tagged by persistPayload); `remember` refuses these tags.
    const note = readNotes().find(n => n.kind === 'saved' && n.tags?.includes('repetition') && n.tags?.includes(`repetition:${id}`))
    if (!note) return `that suggestion has aged out (${id})`
    // The note carries the cron and the action text the miner drafted; the
    // session is not in the loop, so everything needed is on disk.
    const cron = /cron:\s*(\S.*?)(?:\n|$)/.exec(note.text)?.[1]?.trim()
    const action = /action:\s*([\s\S]+)$/.exec(note.text)?.[1]?.trim()
    if (!cron || !action) return `that suggestion is missing its schedule — ask me to set it up by hand`
    // A second tap (or a resend of one cut off mid-run) finds the trigger the first one armed.
    const armed = loadTriggers().find(t => t.enabled && t.schedule === cron && t.action === action)
    if (armed) return `already armed [${armed.id}]: ${cron}`
    const trigger: Trigger = {
      id: randomBytes(4).toString('hex'),
      type: 'cron', action, schedule: cron, repeating: true, enabled: true,
      createdAt: new Date().toISOString(),
      nextRun: computeNextRun(cron, Date.now()),
    }
    const ts = loadTriggers()
    ts.push(trigger)
    saveTriggers(ts)
    installCapability({
      paths: [`trigger:${trigger.id}/action`],
      write: () => [],
      what: `armed a recurring trigger from something the user asked for three times: ${action.slice(0, 80)}`,
      by: 'repetition',
      triggerId: trigger.id,
      proof,
    })
    return `armed. it runs ${cron} — tell me to drop it any time`
  }

  // capability surfacing: nothing is installed, only recorded.
  const rt = loadRuntimeState()
  saveRuntimeState({ ...rt, surfaceState: recordDecline(rt.surfaceState ?? {}, id) })
  if (verb === 'decline') return null
  return null   // "arm capability" is a recipe install — the session runs /otto:recipes
}

function handleUpdatesButton(instruction: string): string | null {
  const state = loadUpdates(UPDATES_FILE)
  const line = updatesTap(state, instruction)
  if (line) saveUpdates(UPDATES_FILE, state)
  return line
}

function sweepButton(verb: 'look' | 'keep', id: string): string {
  const state = loadSweepState(SWEEP_FILE)
  const rec = state.sweeps.find(r => r.id === id)!
  if (!git(['rev-parse', '--verify', '-q', rec.branch]).ok) {
    rec.status = 'stale'; saveSweepState(SWEEP_FILE, state)
    return 'that branch is gone — next month builds a fresh one'
  }
  if (verb === 'keep') { keepSweep(state, rec); return "kept. I won't bring them up again." }
  const paths = git(['diff', '--name-only', `main...${rec.branch}`]).out.split('\n').filter(Boolean)
  const stat = git(['diff', '--stat=60', '--no-color', `main...${rec.branch}`]).out.split('\n').slice(-30).join('\n').slice(0, 2500)
  raiseApproval({
    id: randomBytes(6).toString('hex'), title: 'Drop unused modules', summary: sweepSummary(rec),
    files: paths.map(p => ({ path: p, ...tierForPath(p) })), branch: rec.branch, stat, at: Date.now(),
    apply: { kind: 'sweep', id: rec.id },
  })
  return appSockets.size ? 'the diff is in the app' : 'open the app — the diff waits there for half an hour'
}

function dietButton(month: string): string {
  const state = loadDietState(DIET_FILE)
  const run = state.runs.find(r => r.month === month)!
  // Drop what changed since the offer: a line already gone, a file already deleted.
  const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  run.actions = run.actions.filter(a => a.kind === 'unindex'
    ? read(join(dirForScope(a.scope), 'MEMORY.md'))?.includes(`(${a.file}.md)`)
    : existsSync(join(dirForScope(a.scope), `${a.file}.md`)) && existsSync(join(dirForScope(a.scope), `${a.by}.md`)))
  if (!run.actions.length) { run.status = 'quiet'; saveDietState(DIET_FILE, state); return 'nothing left to trim' }
  saveDietState(DIET_FILE, state)
  const u = run.actions.filter(a => a.kind === 'unindex').length, d = run.actions.length - u
  raiseApproval({
    id: randomBytes(6).toString('hex'), title: 'Memory diet',
    summary: `About ${Math.max(1, Math.round(run.tokens / 1000))}k tokens load before you type. This drops ${u} index lines for memories nothing has recalled (the memories stay searchable) and deletes ${d} memories a newer one replaced. Nothing else changes.`,
    files: dietPaths(run.actions).map(p => ({ path: p.replace(homedir(), '~'), ...tierForPath(p) })),
    stat: renderDiff(run.actions), at: Date.now(), apply: { kind: 'diet', id: month },
  })
  return appSockets.size ? 'the diff is in the app' : 'open the app — the diff waits there for half an hour'
}

async function handleRulebookButton(instruction: string, chat_id: string): Promise<string | null> {
  if (instruction === 'review rulebook') {
    const rules = currentRules()
    const { card, buttons } = rulebookCard(rules)
    await sendServerMessage(chat_id, formatRulebook(rules), { card, buttons, urgent: true })
    return rules.length ? 'tap delete on any you have outgrown' : 'no rules yet'
  }
  const tap = /^delete rule ([a-f0-9]{8})$/.exec(instruction)
  if (!tap) return null
  const rule = findRule(currentRules(), tap[1])
  if (!rule) return 'that rule is already gone'
  logRuleChange(`Deleted rule "${rule.text}" (${rule.scope}/${rule.name})`, deleteRule(rule), 'confirmed', 'user-typed')
  return `deleted: ${rule.text}`
}

async function handleLandlordButton(instruction: string): Promise<string | null> {
  if (!/^(evict|keep) landlord /.test(instruction)) return null
  const state = loadLandlord(LANDLORD_FILE)
  const r = await landlordTap(state, instruction, landlordDeps(homedir(), landlordProtect(), duBytes))
  if (!r) return null
  saveLandlord(LANDLORD_FILE, state)
  if (r.removed.length) {
    appendEntry(CAPABILITY_LOG, {
      id: entryId(), at: new Date().toISOString(), by: 'landlord', tier: 'confirmed', origin: 'user-typed',
      what: `Evicted ${r.removed.length} idle item${r.removed.length === 1 ? '' : 's'} from the disk on [evict]: ${r.removed.map(x => x.label).join(', ')}`,
      paths: r.removed.map(x => x.from),
      revert: { kind: 'none', why: `folders went to the Trash; put them back from there: ${r.removed.map(x => `${x.from} -> ${x.to}`).join('; ')}` },
    })
  }
  return r.line
}

/** [quit it]: only a process this server offered, checked by pid and start time. */
async function handleQuitButton(instruction: string): Promise<string | null> {
  const batch = CLEAR_ORPHANS_RE.exec(instruction)
  if (batch) return clearOrphans(batch[1]!, loadLoadState(RUNAWAY_FILE), { uid: process.getuid?.() ?? -1, protect: protectedPids() })
  const m = QUIT_RE.exec(instruction)
  if (!m) return null
  return quitProcess(Number(m[1]), Number(m[2]), { uid: process.getuid?.() ?? -1, protect: protectedPids(), offered: loadLoadState(RUNAWAY_FILE).offered })
}

async function handleResumeButton(instruction: string): Promise<string | null> {
  const m = RESUME_RE.exec(instruction)
  if (!m) return null
  return resumeWorkspace(m[1]!, { projectsDir: CLAUDE_PROJECTS, app: parachuteConfig(loadAccess().parachute).app, sent: loadParachute(PARACHUTE_FILE).sent })
}

/**
 * A tap on the sleep offer. Only the window the server has pending is honoured,
 * so a `sleep use …` button minted by the reply tool changes nothing. [use]
 * writes quietHours through the settings page's own door (`setting:quiet`);
 * [keep] mutes offers for two weeks.
 */
function handleSleepButton(instruction: string): string | null {
  if (!TAP_RE.test(instruction)) return null
  const r = applyTap(loadSleep(SLEEP_FILE), instruction, Date.now())
  if (!r.ok) return r.line
  if (r.quietHours) {
    if (STATIC) throw new Error('access is in static mode — edit access.json by hand')
    const d = classify(['setting:quiet'], 'user-typed', { kind: 'tapped', buttonData: instruction })
    if (!d.allowed) throw new Error(d.reason)
    saveAccess(setQuietWindow(loadAccess(), r.quietHours))
  }
  saveSleep(SLEEP_FILE, r.state)
  return r.line
}

/** A tap on a backoff offer. Only the offer the server has pending for the schedule the trigger still has is honoured; the rewrite goes through classify() like every other write.
 *  No capability-log inverse: the reply line names the old schedule. */
function handleBackoffButton(instruction: string): string | null {
  if (!BACKOFF_TAP_RE.test(instruction)) return null
  const r = applyBackoffTap(loadTriggers(), instruction, Date.now())
  if (!r.ok) return r.line
  if (r.schedule) {
    const d = classify([`trigger:${r.trigger.id}/schedule`], 'user-typed', { kind: 'tapped', buttonData: instruction })
    if (!d.allowed) throw new Error(d.reason)
    r.trigger.nextRun = computeNextRun(r.schedule, Date.now(), r.trigger.tz)
  }
  saveTriggers(r.triggers)
  return r.line
}

/** A [keep it] or [cancel it] tap settles its deadline before the session sees it. */
export function settleCancelTap(data: string): void {
  const tap = parseCancelTap(data)
  if (!tap) return
  try {
    const state = loadCancelState(CANCEL_NUDGE_FILE)
    if (settleCancelNudge(state, tap)) saveCancelState(CANCEL_NUDGE_FILE, state)
  } catch (err) {
    process.stderr.write(`otto channel: cancel tap not recorded: ${err}\n`)
  }
}
