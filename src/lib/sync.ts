import { type HisaabDB, trackSyncWrite } from './db'
import { TABLES, type SyncFields, type TableName } from './types'

/** Everything the sync core needs, injectable for tests. */
export interface SyncContext {
  db: HisaabDB
  url: string
  anonKey: string
  getToken: () => Promise<string | null>
  /** Force a token refresh after the server rejects a token with 401. */
  refreshToken?: () => Promise<string | null>
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
  const send = async (token: string) => {
    const doFetch = ctx.fetch ?? fetch
    try {
      return await doFetch(`${ctx.url}/rest/v1/${path}`, {
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
  }
  const token = await ctx.getToken()
  if (!token) throw new HttpError(401, 'Not signed in')
  let res = await send(token)
  // A token we thought was valid was rejected (clock change, revoked session):
  // refresh once and retry before giving up.
  if (res.status === 401 && ctx.refreshToken) {
    const fresh = await ctx.refreshToken()
    if (fresh) res = await send(fresh)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new HttpError(res.status, body?.message || `Server error ${res.status}`)
  }
  return res
}

const table = (ctx: SyncContext, name: TableName) => ctx.db.table<SyncFields & Record<string, unknown>, string>(name)

export interface PushFailure {
  table: TableName
  id: string
  message: string
}

export interface PushResult {
  pushed: number
  /** Rows the server refused (FK/CHECK/RLS). They stay dirty and are retried next sync. */
  failed: PushFailure[]
}

/** A 4xx that is about the data itself, not auth, rate limits or the network. */
const isRowRejection = (err: unknown) =>
  err instanceof HttpError && err.status >= 400 && err.status < 500 && ![401, 403, 408, 429].includes(err.status)

type Row = SyncFields & Record<string, unknown>

/** Upsert one chunk. Returns the rows the server actually wrote. */
async function upsert(ctx: SyncContext, name: TableName, chunk: Row[]): Promise<Record<string, unknown>[]> {
  const res = await request(ctx, `${name}?on_conflict=id`, {
    method: 'POST',
    // return=representation lists only rows the trigger accepted, so rows it
    // ignored (an older edit arriving late) are the ones missing from the reply.
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(chunk.map((r) => toRemote(name, r))),
  })
  const text = await res.text()
  return text ? (JSON.parse(text) as Record<string, unknown>[]) : []
}

/**
 * Upload dirty rows, parent tables first, in chunks. If the server rejects a
 * chunk because of its data, rows are retried one by one so a single bad row
 * can't block everything else; rejected rows are reported in `failed`.
 */
export async function push(ctx: SyncContext): Promise<PushResult> {
  let pushed = 0
  const failed: PushFailure[] = []
  for (const name of TABLES) {
    const t = table(ctx, name)
    const dirty = await t.where('dirty').equals(1).toArray()
    const size = ctx.pushChunk ?? PUSH_CHUNK
    const chunks: Row[][] = []
    for (let i = 0; i < dirty.length; i += size) chunks.push(dirty.slice(i, i + size))
    while (chunks.length) {
      const chunk = chunks.shift()!
      let written: Record<string, unknown>[]
      try {
        written = await upsert(ctx, name, chunk)
      } catch (err) {
        if (!isRowRejection(err)) throw err
        if (chunk.length > 1) {
          chunks.unshift(...chunk.map((r) => [r])) // isolate the bad row(s)
          continue
        }
        failed.push({ table: name, id: chunk[0].id, message: (err as Error).message })
        continue
      }
      // Clear dirty only for rows not edited again while the upload was in flight.
      await trackSyncWrite(() =>
        ctx.db.transaction('rw', t, async () => {
          const now = await t.bulkGet(chunk.map((r) => r.id))
          const unchanged = now.filter(
            (row, i): row is NonNullable<typeof row> => !!row && row.updated_at === chunk[i].updated_at,
          )
          if (unchanged.length) await t.bulkPut(unchanged.map((row) => ({ ...row, dirty: 0 as const })))
        }),
      )
      // Rows missing from the reply were ignored by the trigger because the
      // server already has a newer edit: fetch that winner so this phone shows
      // it even if its server_updated_at is older than our pull cursor.
      const accepted = new Set(written.map((r) => r.id as string))
      const ignored = chunk.map((r) => r.id).filter((id) => !accepted.has(id))
      if (ignored.length) await reconcile(ctx, name, ignored)
      pushed += chunk.length
    }
  }
  return { pushed, failed }
}

async function reconcile(ctx: SyncContext, name: TableName, ids: string[]) {
  const res = await request(ctx, `${name}?select=*&id=in.(${ids.join(',')})`)
  const rows = (await res.json()) as Record<string, unknown>[]
  await apply(ctx, name, rows, true)
}

/** Write server rows locally, skipping rows with unpushed local edits. */
async function apply(ctx: SyncContext, name: TableName, rows: Record<string, unknown>[], onlyIfNewer = false) {
  const t = table(ctx, name)
  const incoming = rows.map((r) => toLocal(name, r))
  // One bulk read + one bulk write keeps the transaction short, so screens
  // reading the same tables aren't left waiting behind a long sync.
  await trackSyncWrite(() =>
    ctx.db.transaction('rw', t, async () => {
      const locals = await t.bulkGet(incoming.map((r) => r.id))
      const toWrite = incoming.filter((row, i) => {
        const local = locals[i]
        if (local?.dirty) return false // local edit wins until it's pushed
        if (onlyIfNewer && local && parseTs(row.updated_at) <= parseTs(local.updated_at)) return false
        return true
      })
      if (toWrite.length) await t.bulkPut(toWrite)
    }),
  )
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
    // Keyset paging on (server_updated_at, id): rows sharing one timestamp
    // across a page boundary are never skipped.
    let after: { ts: string; id: string } | null = null
    for (;;) {
      const filter = after
        ? `or=${encodeURIComponent(
            `(server_updated_at.gt."${after.ts}",and(server_updated_at.eq."${after.ts}",id.gt.${after.id}))`,
          )}`
        : `server_updated_at=gt.${encodeURIComponent(since)}`
      const q = `${name}?select=*&${filter}&order=server_updated_at.asc,id.asc&limit=${pageSize}`
      const rows = (await (await request(ctx, q)).json()) as Record<string, unknown>[]
      if (rows.length === 0) break
      await apply(ctx, name, rows)
      pulled += rows.length
      // Keep the server's own string (microsecond precision) as the cursor.
      const last = rows[rows.length - 1]
      after = { ts: last.server_updated_at as string, id: last.id as string }
      if (!newest || parseTs(after.ts) >= parseTs(newest)) newest = after.ts
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
