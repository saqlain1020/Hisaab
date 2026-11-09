import type { HisaabDB } from './db'
import { TABLES, type SyncFields, type TableName } from './types'

/** Everything the sync core needs, injectable for tests. */
export interface SyncContext {
  db: HisaabDB
  url: string
  anonKey: string
  getToken: () => Promise<string | null>
  fetch?: typeof fetch
  pushChunk?: number
  pageSize?: number
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const PUSH_CHUNK = 200
const PAGE_SIZE = 500
const REWIND_MS = 60_000

// Remote column lists. `dirty` never leaves the phone; server_updated_at is server-owned.
const COLUMNS: Record<TableName, string[]> = {
  trips: ['id', 'name', 'currency', 'created_at', 'updated_at', 'deleted'],
  members: ['id', 'trip_id', 'name', 'updated_at', 'deleted'],
  expenses: ['id', 'trip_id', 'title', 'amount_minor', 'paid_by', 'spent_at', 'notes', 'shares', 'updated_at', 'deleted'],
  settlements: ['id', 'trip_id', 'from_member', 'to_member', 'amount_minor', 'paid_at', 'updated_at', 'deleted'],
}

const TIME_COLUMNS = new Set(['created_at', 'updated_at', 'spent_at', 'paid_at'])

/**
 * Parse a Postgres timestamp ("2026-11-09T10:00:00.123456+00:00") into ms.
 * Trims sub-millisecond digits first, which older Safari versions reject.
 */
export function parseTs(v: string): number {
  return Date.parse(v.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'))
}

function toRemote(table: TableName, row: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const c of COLUMNS[table]) out[c] = row[c]
  return out
}

/** Server row → local row. Timestamps are normalised to ms ISO so string comparisons work. */
function toLocal(table: TableName, row: Record<string, unknown>): SyncFields & Record<string, unknown> {
  const out: Record<string, unknown> = { dirty: 0 }
  for (const c of COLUMNS[table]) {
    const v = row[c]
    out[c] = TIME_COLUMNS.has(c) && typeof v === 'string' ? new Date(parseTs(v)).toISOString() : v
  }
  if (table === 'expenses' || table === 'settlements') out.amount_minor = Number(out.amount_minor)
  if (table === 'expenses' && Array.isArray(out.shares))
    out.shares = (out.shares as { member_id: string; amount_minor: unknown }[]).map((s) => ({
      member_id: s.member_id,
      amount_minor: Number(s.amount_minor),
    }))
  return out as SyncFields & Record<string, unknown>
}

async function request(ctx: SyncContext, path: string, init: RequestInit = {}) {
  const token = await ctx.getToken()
  if (!token) throw new HttpError(401, 'Not signed in')
  const doFetch = ctx.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${ctx.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ctx.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch {
    throw new HttpError(0, 'No connection')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new HttpError(res.status, body?.message || `Server error ${res.status}`)
  }
  return res
}

const table = (ctx: SyncContext, name: TableName) => ctx.db.table<SyncFields & Record<string, unknown>, string>(name)

/** Upload dirty rows, parent tables first, in chunks. Returns how many rows were uploaded. */
export async function push(ctx: SyncContext): Promise<number> {
  let pushed = 0
  for (const name of TABLES) {
    const t = table(ctx, name)
    const dirty = await t.where('dirty').equals(1).toArray()
    const size = ctx.pushChunk ?? PUSH_CHUNK
    for (let i = 0; i < dirty.length; i += size) {
      const chunk = dirty.slice(i, i + size)
      await request(ctx, `${name}?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk.map((r) => toRemote(name, r))),
      })
      // Clear dirty only for rows not edited again while the upload was in flight.
      await ctx.db.transaction('rw', t, async () => {
        for (const sent of chunk) {
          const now = await t.get(sent.id)
          if (now && now.updated_at === sent.updated_at) await t.update(sent.id, { dirty: 0 })
        }
      })
      await reconcile(ctx, name, chunk.map((r) => r.id))
      pushed += chunk.length
    }
  }
  return pushed
}

/**
 * The server trigger silently keeps the newer row when an older offline edit
 * arrives late. Re-read what we just pushed so this phone picks up the winner
 * even if its server_updated_at is older than our pull cursor.
 */
async function reconcile(ctx: SyncContext, name: TableName, ids: string[]) {
  const res = await request(ctx, `${name}?select=*&id=in.(${ids.join(',')})`)
  const rows = (await res.json()) as Record<string, unknown>[]
  await apply(ctx, name, rows, true)
}

/** Write server rows locally, skipping rows with unpushed local edits. */
async function apply(ctx: SyncContext, name: TableName, rows: Record<string, unknown>[], onlyIfNewer = false) {
  const t = table(ctx, name)
  await ctx.db.transaction('rw', t, async () => {
    for (const raw of rows) {
      const incoming = toLocal(name, raw)
      const local = await t.get(incoming.id)
      if (local?.dirty) continue // local edit wins until it's pushed
      if (onlyIfNewer && local && parseTs(incoming.updated_at) <= parseTs(local.updated_at)) continue
      await t.put(incoming)
    }
  })
}

const cursorKey = (name: TableName) => `cursor:${name}`

/** Download rows changed since each table's cursor (rewound 60 s), in pages. */
export async function pull(ctx: SyncContext): Promise<number> {
  let pulled = 0
  const pageSize = ctx.pageSize ?? PAGE_SIZE
  for (const name of TABLES) {
    const saved = (await ctx.db.meta.get(cursorKey(name)))?.value as string | undefined
    let since = saved ? new Date(parseTs(saved) - REWIND_MS).toISOString() : '1970-01-01T00:00:00Z'
    let newest = saved
    for (;;) {
      const q =
        `${name}?select=*&server_updated_at=gt.${encodeURIComponent(since)}` +
        `&order=server_updated_at.asc,id.asc&limit=${pageSize}`
      const rows = (await (await request(ctx, q)).json()) as Record<string, unknown>[]
      if (rows.length === 0) break
      await apply(ctx, name, rows)
      pulled += rows.length
      // Keep the server's own string (microsecond precision) as the cursor.
      since = rows[rows.length - 1].server_updated_at as string
      if (!newest || parseTs(since) >= parseTs(newest)) newest = since
      await ctx.db.meta.put({ key: cursorKey(name), value: newest })
      if (rows.length < pageSize) break
    }
  }
  return pulled
}

export async function countDirty(db: HisaabDB): Promise<number> {
  const counts = await Promise.all(TABLES.map((n) => db.table(n).where('dirty').equals(1).count()))
  return counts.reduce((a, b) => a + b, 0)
}
