import { Cron } from 'croner'

export function computeNextRun(schedule: string, after: number, tz?: string): number | undefined {
  const asDate = Date.parse(schedule)
  if (!Number.isNaN(asDate) && /\d{4}-\d{2}-\d{2}/.test(schedule)) {
    return asDate > after ? asDate : asDate // past one-shots fire immediately once
  }
  try {
    const next = new Cron(schedule, { timezone: tz }).nextRun(new Date(after))
    return next ? next.getTime() : undefined
  } catch {
    return undefined
  }
}
