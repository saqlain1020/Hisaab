import Dexie, { type EntityTable } from 'dexie'
import type { Expense, Member, Settlement, Trip } from './types'

export interface Meta {
  key: string
  value: unknown
}

export class HisaabDB extends Dexie {
  trips!: EntityTable<Trip, 'id'>
  members!: EntityTable<Member, 'id'>
  expenses!: EntityTable<Expense, 'id'>
  settlements!: EntityTable<Settlement, 'id'>
  meta!: EntityTable<Meta, 'key'>

  constructor(name = 'hisaab') {
    // No shared query cache: a retry after a stuck read (see useLocalQuery) must
    // issue a fresh IndexedDB request instead of joining the stuck one.
    super(name, { cache: 'disabled' })
    this.version(1).stores({
      trips: 'id, dirty',
      members: 'id, trip_id, dirty',
      expenses: 'id, trip_id, dirty',
      settlements: 'id, trip_id, dirty',
      meta: 'key',
    })
  }
}

export const db = new HisaabDB()

/**
 * Timestamp for a local save: max(now, previous + 1ms), so a phone whose clock
 * is behind still moves a row forward and wins over its own earlier edit.
 */
export function nextStamp(previous?: string, now = Date.now()): string {
  const prev = previous ? Date.parse(previous) : NaN
  const ms = Number.isFinite(prev) ? Math.max(now, prev + 1) : now
  return new Date(ms).toISOString()
}

/**
 * When a sync write transaction started (null when none is running). Reads queue
 * behind writes, so the stuck-read watchdog waits for these instead of reopening
 * the database underneath them.
 */
let writeStartedAt: number | null = null
export const syncWriteStartedAt = () => writeStartedAt
export async function trackSyncWrite<T>(fn: () => Promise<T>): Promise<T> {
  writeStartedAt = Date.now()
  try {
    return await fn()
  } finally {
    writeStartedAt = null
  }
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}
