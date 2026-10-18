import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
// Types only: the assertions below are checked by tsc, which the last test runs.
import type * as D from '../dash-types.ts'
import type { AppToken, Scope, listAppTokens } from '../apptokens.ts'
import type { StatusRow, Verdict, recentRepairLines } from '../status.ts'
import type { BriefData, TriggerGist } from '../brief.ts'
import type { Item, Graph, PersonCard, viewerData, searchMemory } from '../memviewer.ts'
import type { Toggle, Section, triggerToggles } from '../settings.ts'
import type { Note } from '../store.ts'
import type { HygienePlan } from '../hygiene.ts'
import type { MoneyRecord, CurrencyTotal, MonthTotals, totalsByCategory } from '../money.ts'
import type { Place, PlaceKind, PlaceStatus } from '../places.ts'
import type { SourceStats } from '../ledger.ts'
import type { CapEntry } from '../changelog.ts'
import type { Job, JobState } from '../jobs.ts'
import type { Trip, FlightSegment, StaySegment, ZonedTime, tripProblems } from '../trips.ts'
import type { currentOrNextTrip } from '../triplife.ts'
import type { PackageRecord, PackageEvent, PackageStatus } from '../packages.ts'
import type { ChatEntry } from '../chatfeed.ts'

/**
 * Compiles only when A and B are assignable both ways and have the same keys —
 * `({} as A) satisfies B` and the reverse, plus a key check, since assignability
 * alone lets an extra optional field through.
 */
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? [keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : false : false : false : false
const same = <A, B>(ok: Same<A, B>) => ok

// Every DTO against the record it is picked from. A field dropped from the DTO
// on purpose appears in the Omit/Pick, so the drop is visible here.
const checks: true[] = [
  same<D.Scope, Scope>(true),
  same<D.Device, Omit<AppToken, 'hash'>>(true),
  same<D.Device, ReturnType<typeof listAppTokens>[number]>(true),
  same<D.Verdict, Verdict>(true),
  same<D.StatusRow, StatusRow>(true),
  same<D.DashStatus['repairs'], ReturnType<typeof recentRepairLines>>(true),
  same<D.DashBrief, BriefData>(true),
  same<D.MemoryItem, Omit<Item, 'body' | 'undo' | 'source'>>(true),
  same<D.MemoryItemDetail, Omit<Item, 'undo' | 'source'>>(true),
  same<D.MemoryGraph, Graph>(true),
  same<D.DashMemory['summary'], Parameters<typeof viewerData>[1]>(true),
  same<D.MemorySearch, Extract<Awaited<ReturnType<typeof searchMemory>>, { results: unknown }>>(true),
  same<D.DashError, Extract<Awaited<ReturnType<typeof searchMemory>>, { error: unknown }>>(true),
  same<D.PersonCard, PersonCard>(true),
  same<D.Toggle, Toggle>(true),
  same<D.ToggleSection, Section>(true),
  same<D.TriggerRow['nextRun'], TriggerGist['nextRun']>(true),
  // key, confirmedAt and supersededBy belong to facts (facts.ts); a loop never carries them.
  same<D.LoopRow, Omit<Note, 'kind' | 'source' | 'undo' | 'key' | 'confirmedAt' | 'supersededBy'>>(true),
  same<D.HygienePlan, HygienePlan>(true),
  // purchase feeds return windows (returns.ts); the dashboard's money view doesn't show it.
  same<D.MoneyRow, Omit<MoneyRecord, 'source' | 'purchase'>>(true),
  same<D.CurrencyTotal, CurrencyTotal>(true),
  same<D.MonthTotals, MonthTotals>(true),
  same<D.CategoryTotal, ReturnType<typeof totalsByCategory>[number]>(true),
  // recommenderId is a people.json id, which can be an email address.
  same<D.PlaceRow, Omit<Place, 'recommenderId'>>(true),
  same<D.PlaceKind, PlaceKind>(true),
  same<D.PlaceStatus, PlaceStatus>(true),
  same<D.SourceStats, SourceStats>(true),
  same<D.CapRow, Omit<CapEntry, 'revert'>>(true),
  same<D.JobState, JobState>(true),
  // chatId is a chat identifier; a browser has no use for it.
  same<D.JobRow, Omit<Job, 'scratchDir' | 'pid' | 'chatId'>>(true),
  same<D.ZonedTime, ZonedTime>(true),
  same<D.ChatMessage, Pick<ChatEntry, 'dir' | 'kind' | 'text' | 'ts'> & { id: string }>(true),
  same<D.FlightRow, Pick<FlightSegment, 'kind' | 'flight' | 'carrier' | 'from' | 'to' | 'depart' | 'arrive'>>(true),
  same<D.StayRow, Pick<StaySegment, 'kind' | 'name' | 'city' | 'checkIn' | 'checkOut'>>(true),
  same<Omit<D.TripRow, 'segments'>, Omit<Trip, 'segments' | 'pnrs' | 'sources' | 'fired'>>(true),
  same<NonNullable<D.DashTrips['current']>['mode'], NonNullable<ReturnType<typeof currentOrNextTrip>>['mode']>(true),
  same<D.DashTrips['problems'][string], ReturnType<typeof tripProblems>>(true),
  same<D.PackageStatus, PackageStatus>(true),
  // carrierName and trackingUrl are derived for display; sources and createdAt stay home.
  same<Omit<D.PackageRow, 'carrierName' | 'trackingUrl' | 'events'>, Omit<PackageRecord, 'events' | 'sources' | 'createdAt' | 'orderRef'>>(true),
  same<D.PackageRow['events'][number], Omit<PackageEvent, 'source'>>(true),
]

// The server's Trigger type is private to server.ts; settings.ts's view of it is
// the closest exported shape, so a TriggerRow must at least satisfy that.
const triggerFits = (t: D.TriggerRow): Parameters<typeof triggerToggles>[0][number] => ({ ...t, action: t.gist })
void triggerFits

// No DTO has a slot for a key that must never leave the Mac.
type Forbidden = 'undo' | 'source' | 'sources' | 'pnr' | 'pnrs' | 'confirmation' | 'seat' | 'address' | 'revert' | 'scratchDir' | 'pid' | 'hash' | 'addresses' | 'phones' | 'handles' | 'chatId' | 'chat_id' | 'recommenderId'
type Keys<T> = T extends unknown ? keyof T : never
type RowKeys = Keys<D.Device | D.StatusRow | D.MemoryItem | D.MemoryItemDetail | D.PersonCard | D.Toggle | D.TriggerRow | D.LoopRow | D.MoneyRow | D.CapRow | D.JobRow | D.TripRow | D.FlightRow | D.StayRow | D.PairPoll | D.ChatMessage | D.PackageRow | D.PackageRow['events'][number] | D.PlaceRow>
const noForbidden: [Extract<RowKeys, Forbidden>] extends [never] ? true : false = true
// `body` only on the single-item route.
const noBodyOnList: 'body' extends keyof D.MemoryItem ? false : true = true

test('every DTO matches its source type', () => {
  expect(checks.every(Boolean) && noForbidden && noBodyOnList).toBe(true)
})

test('dash-types.ts is standalone: no imports, so it can be copied verbatim', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'dash-types.ts'), 'utf8')
  expect(src).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m)
})

test('the type assertions above compile', () => {
  // bun strips types without checking them, so the checks above mean nothing until tsc runs.
  const p = Bun.spawnSync(
    ['bun', 'x', '-p', 'typescript@5.9.3', 'tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'esnext', '--module', 'esnext',
      '--moduleResolution', 'bundler', '--allowImportingTsExtensions', '--types', 'bun', 'tests/dash-types.test.ts'],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  )
  const out = p.stdout.toString() + p.stderr.toString()
  // A tsc that never ran reports nothing, which must not read as a pass.
  expect(p.exitCode === 0 || out.includes('error TS')).toBe(true)
  // Errors in the source modules themselves are not this test's business.
  const mine = out.split('\n').filter(l => /^(tests\/dash-types\.test\.ts|dash-types\.ts)\(/.test(l))
  expect(mine).toEqual([])
}, 60_000)
