import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { HisaabDB, nextStamp } from './db'
import { countDirty, pull, push, type SyncContext } from './sync'
import type { Expense, Member, Trip } from './types'

/**
 * A tiny in-memory PostgREST stand-in that mimics schema.sql: upsert on id,
 * the hisaab_on_write trigger (older updated_at is ignored, server_updated_at
 * stamped on every accepted write), and the filters the sync engine uses.
 */
function fakeServer() {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {
    trips: new Map(),
    members: new Map(),
    expenses: new Map(),
    settlements: new Map(),
  }
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const tick = () => new Date(frozen ? clock : (clock += 1000)).toISOString().replace('Z', '123+00:00') // microsecond-style
  const requests: string[] = []

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const name = url.pathname.split('/').pop()!
    const table = tables[name]
    requests.push(`${init?.method ?? 'GET'} ${name}`)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>[]
      // Like a CHECK/FK violation: the whole statement fails, nothing is written.
      if (body.some((r) => r.name === 'BAD')) return new Response(JSON.stringify({ message: 'bad row' }), { status: 400 })
      const written: Record<string, unknown>[] = []
      for (const row of body) {
        const old = table.get(row.id as string)
        if (old && Date.parse(row.updated_at as string) < Date.parse(old.updated_at as string)) continue
        const next = { ...old, ...row, server_updated_at: tick() }
        table.set(row.id as string, next)
        written.push(next)
      }
      const representation = String(new Headers(init.headers).get('Prefer')).includes('return=representation')
      return new Response(representation ? JSON.stringify(written) : null, { status: 201 })
    }
    let rows = [...table.values()]
    const gt = url.searchParams.get('server_updated_at')
    if (gt) {
      const since = Date.parse(gt.slice(3).replace(/(\.\d{3})\d+/, '$1'))
      rows = rows.filter((r) => Date.parse((r.server_updated_at as string).replace(/(\.\d{3})\d+/, '$1')) > since)
    }
    const or = url.searchParams.get('or')
    if (or) {
      const m = /server_updated_at\.gt\."([^"]+)",and\(server_updated_at\.eq\."[^"]+",id\.gt\.([^)]+)\)/.exec(or)!
      rows = rows.filter((r) => {
        const ts = r.server_updated_at as string
        return ts > m[1] || (ts === m[1] && (r.id as string) > m[2])
      })
    }
    const ids = url.searchParams.get('id')
    if (ids) {
      const set = new Set(ids.slice(4, -1).split(','))
      rows = rows.filter((r) => set.has(r.id as string))
    }
    rows.sort((a, b) => String(a.server_updated_at).localeCompare(String(b.server_updated_at)) || String(a.id).localeCompare(String(b.id)))
    const limit = Number(url.searchParams.get('limit') ?? 1e9)
    return new Response(JSON.stringify(rows.slice(0, limit)), { status: 200 })
  }) as typeof fetch

  /** Make the next writes share one timestamp, like a fast bulk insert. */
  let frozen = false
  const freeze = (on: boolean) => {
    frozen = on
  }
  const advance = (ms: number) => {
    clock += ms
  }
  return { tables, fetch: fetchFn, requests, advance, freeze }
}

let n = 0
function phone(server: ReturnType<typeof fakeServer>, opts: Partial<SyncContext> = {}) {
  const db = new HisaabDB(`test-${++n}`)
  const ctx: SyncContext = {
    db,
    url: 'https://x.supabase.co',
    anonKey: 'anon',
    getToken: async () => 'token',
    fetch: server.fetch,
    ...opts,
  }
  return { db, ctx }
}

const t0 = '2026-01-01T00:00:00.000Z'
const trip = (id: string): Trip => ({ id, name: 'Hunza', currency: 'PKR', created_at: t0, updated_at: t0, deleted: false, dirty: 1 })
const member = (id: string, name: string): Member => ({ id, trip_id: 'trip1', name, updated_at: t0, deleted: false, dirty: 1 })

describe('sync engine', () => {
  let server: ReturnType<typeof fakeServer>
  beforeEach(() => {
    server = fakeServer()
  })

  it('pushes parents before children and clears dirty', async () => {
    const a = phone(server)
    await a.db.members.add(member('m1', 'Ali'))
    await a.db.trips.add(trip('trip1'))
    expect(await countDirty(a.db)).toBe(2)
    await push(a.ctx)
    expect(server.requests.filter((r) => r.startsWith('POST'))).toEqual(['POST trips', 'POST members'])
    expect(await countDirty(a.db)).toBe(0)
    expect(server.tables.members.get('m1')).not.toHaveProperty('dirty')
  })

  it('pushes in chunks', async () => {
    const a = phone(server, { pushChunk: 2 })
    await a.db.trips.bulkAdd([trip('t1'), trip('t2'), trip('t3'), trip('t4'), trip('t5')])
    expect((await push(a.ctx)).pushed).toBe(5)
    expect(server.requests.filter((r) => r === 'POST trips')).toHaveLength(3)
  })

  it('keeps a row dirty if it was edited during the upload', async () => {
    const original = server.fetch
    const a = phone(server, {
      fetch: (async (input, init) => {
        if (init?.method === 'POST') {
          const t = (await a.db.trips.get('trip1'))!
          await a.db.trips.put({ ...t, name: 'Edited mid-upload', updated_at: nextStamp(t.updated_at), dirty: 1 })
        }
        return original(input, init)
      }) as typeof fetch,
    })
    await a.db.trips.add(trip('trip1'))
    await push(a.ctx)
    const local = (await a.db.trips.get('trip1'))!
    expect(local.dirty).toBe(1)
    expect(local.name).toBe('Edited mid-upload')
  })

  it('syncs between two phones, in pages, and moves cursors forward', async () => {
    const a = phone(server)
    const b = phone(server, { pageSize: 2 })
    await a.db.trips.add(trip('trip1'))
    await a.db.members.bulkAdd([member('m1', 'Ali'), member('m2', 'Bilal'), member('m3', 'Sara')])
    await push(a.ctx)

    expect(await pull(b.ctx)).toBe(4)
    expect((await b.db.members.toArray()).map((m) => m.name).sort()).toEqual(['Ali', 'Bilal', 'Sara'])
    expect((await b.db.members.get('m1'))!.dirty).toBe(0)
    expect((await b.db.meta.get('cursor:members'))!.value).toMatch(/^2026-01-01T00:00:04/)

    // Re-reading the 60 s window again is harmless.
    await pull(b.ctx)
    expect(await b.db.members.count()).toBe(3)
  })

  it('does not skip rows that share a timestamp across a page boundary', async () => {
    const a = phone(server)
    const b = phone(server, { pageSize: 3 })
    await a.db.trips.add(trip('trip1'))
    await a.db.members.bulkAdd(Array.from({ length: 10 }, (_, i) => member(`m${i}`, `Friend ${i}`)))
    server.freeze(true) // all 10 members get the same server_updated_at
    await push(a.ctx)
    server.freeze(false)
    await pull(b.ctx)
    expect(await b.db.members.count()).toBe(10)
  })

  it('does not overwrite rows that are dirty locally', async () => {
    const a = phone(server)
    const b = phone(server)
    await a.db.trips.add(trip('trip1'))
    await push(a.ctx)
    await pull(b.ctx)

    const tb = (await b.db.trips.get('trip1'))!
    await b.db.trips.put({ ...tb, name: 'B local edit', updated_at: nextStamp(tb.updated_at), dirty: 1 })
    const ta = (await a.db.trips.get('trip1'))!
    await a.db.trips.put({ ...ta, name: 'A edit', updated_at: nextStamp(ta.updated_at, Date.parse(ta.updated_at) + 5000), dirty: 1 })
    await push(a.ctx)

    await pull(b.ctx)
    expect((await b.db.trips.get('trip1'))!.name).toBe('B local edit')
  })

  it('newest edit wins, even when the older one uploads last', async () => {
    const a = phone(server)
    const b = phone(server)
    await a.db.trips.add(trip('trip1'))
    await push(a.ctx)
    await pull(b.ctx)

    // A edits at 10:00 offline; B edits at 11:00 and syncs first.
    const ta = (await a.db.trips.get('trip1'))!
    await a.db.trips.put({ ...ta, name: 'Old offline edit', updated_at: '2026-01-02T10:00:00.000Z', dirty: 1 })
    const tb = (await b.db.trips.get('trip1'))!
    await b.db.trips.put({ ...tb, name: 'Newer edit', updated_at: '2026-01-02T11:00:00.000Z', dirty: 1 })
    await push(b.ctx)

    // An hour later another write lands; A pulls first (skipping its dirty trip),
    // so its cursor is now far past B's edit.
    server.advance(3_600_000)
    await b.db.trips.add(trip('trip2'))
    await push(b.ctx)
    await pull(a.ctx)
    expect((await a.db.trips.get('trip1'))!.name).toBe('Old offline edit')

    await push(a.ctx)
    await pull(a.ctx)
    expect(server.tables.trips.get('trip1')!.name).toBe('Newer edit')
    expect((await a.db.trips.get('trip1'))!.name).toBe('Newer edit')
    expect((await a.db.trips.get('trip1'))!.dirty).toBe(0)
  })

  it('syncs soft deletes and expense shares together', async () => {
    const a = phone(server)
    const b = phone(server)
    await a.db.trips.add(trip('trip1'))
    await a.db.members.bulkAdd([member('m1', 'Ali'), member('m2', 'Bilal')])
    const e: Expense = {
      id: 'e1', trip_id: 'trip1', title: 'Dinner', amount_minor: 300001, paid_by: 'm1', spent_at: t0, notes: '',
      shares: [{ member_id: 'm1', amount_minor: 150001 }, { member_id: 'm2', amount_minor: 150000 }],
      updated_at: t0, deleted: false, dirty: 1,
    }
    await a.db.expenses.add(e)
    await push(a.ctx)
    await pull(b.ctx)
    expect((await b.db.expenses.get('e1'))!.shares).toEqual(e.shares)

    await a.db.expenses.put({ ...e, deleted: true, updated_at: nextStamp(e.updated_at), dirty: 1 })
    await push(a.ctx)
    await pull(b.ctx)
    expect((await b.db.expenses.get('e1'))!.deleted).toBe(true)
  })

  it('only re-reads rows the server ignored', async () => {
    const a = phone(server)
    await a.db.trips.add(trip('trip1'))
    await push(a.ctx)
    expect(server.requests.filter((r) => r === 'GET trips')).toHaveLength(0) // nothing ignored → no extra GET
  })

  it('a rejected row does not block the rest of the upload', async () => {
    const a = phone(server, { pushChunk: 10 })
    await a.db.trips.add(trip('trip1'))
    await a.db.members.bulkAdd([member('m1', 'Ali'), member('m2', 'BAD'), member('m3', 'Sara')])
    const e: Expense = {
      id: 'e1', trip_id: 'trip1', title: 'Tea', amount_minor: 100, paid_by: 'm1', spent_at: t0, notes: '',
      shares: [{ member_id: 'm1', amount_minor: 100 }], updated_at: t0, deleted: false, dirty: 1,
    }
    await a.db.expenses.add(e)
    const result = await push(a.ctx)
    expect(result.failed).toEqual([{ table: 'members', id: 'm2', message: 'bad row' }])
    expect([...server.tables.members.keys()].sort()).toEqual(['m1', 'm3'])
    expect(server.tables.expenses.has('e1')).toBe(true) // later tables still upload
    expect((await a.db.members.get('m2'))!.dirty).toBe(1) // kept for retry
    expect(await countDirty(a.db)).toBe(1)
  })

  it('refreshes the token and retries once after a 401', async () => {
    let token = 'expired'
    const a = phone(server, {
      getToken: async () => token,
      refreshToken: async () => (token = 'fresh'),
      fetch: (async (input, init) => {
        const auth = new Headers(init?.headers).get('Authorization')
        if (auth === 'Bearer expired') return new Response(JSON.stringify({ message: 'JWT expired' }), { status: 401 })
        return server.fetch(input, init)
      }) as typeof fetch,
    })
    await a.db.trips.add(trip('trip1'))
    expect((await push(a.ctx)).pushed).toBe(1)
    expect(token).toBe('fresh')
  })

  it('surfaces server errors and leaves rows dirty', async () => {
    const a = phone(server, { fetch: (async () => new Response(JSON.stringify({ message: 'nope' }), { status: 403 })) as typeof fetch })
    await a.db.trips.add(trip('trip1'))
    await expect(push(a.ctx)).rejects.toThrow('nope')
    expect(await countDirty(a.db)).toBe(1)
  })
})
