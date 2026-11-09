import { db, nextStamp } from './db'
import type { Expense, Member, Settlement, Share, Trip } from './types'

/** Called after every local write; the sync engine sets this to schedule an upload. */
let onLocalChange: () => void = () => {}
export function setLocalChangeListener(fn: () => void) {
  onLocalChange = fn
}

function changed<T>(v: T): T {
  onLocalChange()
  return v
}

export class ValidationError extends Error {}

const uuid = () => crypto.randomUUID()

// ---------- Trips ----------

export async function createTrip(name: string, currency: string): Promise<string> {
  name = name.trim()
  currency = currency.trim().toUpperCase() || 'PKR'
  if (!name) throw new ValidationError('Give the trip a name.')
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('Currency should be a 3-letter code like PKR.')
  const now = new Date().toISOString()
  const trip: Trip = { id: uuid(), name, currency, created_at: now, updated_at: now, deleted: false, dirty: 1 }
  await db.trips.add(trip)
  return changed(trip.id)
}

export async function updateTrip(id: string, patch: Partial<Pick<Trip, 'name' | 'currency' | 'deleted'>>) {
  if (patch.name !== undefined) {
    patch.name = patch.name.trim()
    if (!patch.name) throw new ValidationError('Give the trip a name.')
  }
  await db.transaction('rw', db.trips, async () => {
    const t = await db.trips.get(id)
    if (!t) throw new Error('Trip not found')
    await db.trips.put({ ...t, ...patch, updated_at: nextStamp(t.updated_at), dirty: 1 })
  })
  changed(null)
}

export const deleteTrip = (id: string) => updateTrip(id, { deleted: true })

// ---------- Members ----------

async function assertUniqueName(tripId: string, name: string, exceptId?: string) {
  const lower = name.toLocaleLowerCase()
  const clash = await db.members
    .where('trip_id')
    .equals(tripId)
    .filter((m) => !m.deleted && m.id !== exceptId && m.name.trim().toLocaleLowerCase() === lower)
    .first()
  if (clash) throw new ValidationError(`There's already a friend called "${clash.name}".`)
}

export async function addMember(tripId: string, name: string): Promise<string> {
  name = name.trim()
  if (!name) throw new ValidationError('Enter a name.')
  const id = uuid()
  await db.transaction('rw', db.members, async () => {
    await assertUniqueName(tripId, name)
    await db.members.add({ id, trip_id: tripId, name, updated_at: nextStamp(), deleted: false, dirty: 1 })
  })
  return changed(id)
}

export async function renameMember(id: string, name: string) {
  name = name.trim()
  if (!name) throw new ValidationError('Enter a name.')
  await db.transaction('rw', db.members, async () => {
    const m = await db.members.get(id)
    if (!m) throw new Error('Friend not found')
    await assertUniqueName(m.trip_id, name, id)
    await db.members.put({ ...m, name, updated_at: nextStamp(m.updated_at), dirty: 1 })
  })
  changed(null)
}

export async function isMemberInvolved(member: Member): Promise<boolean> {
  const expenses = await db.expenses.where('trip_id').equals(member.trip_id).toArray()
  const inExpense = expenses.some(
    (e) => !e.deleted && (e.paid_by === member.id || e.shares.some((s) => s.member_id === member.id)),
  )
  if (inExpense) return true
  const settlements = await db.settlements.where('trip_id').equals(member.trip_id).toArray()
  return settlements.some((s) => !s.deleted && (s.from_member === member.id || s.to_member === member.id))
}

export async function removeMember(id: string) {
  await db.transaction('rw', db.members, db.expenses, db.settlements, async () => {
    const m = await db.members.get(id)
    if (!m) throw new Error('Friend not found')
    if (await isMemberInvolved(m))
      throw new ValidationError(`${m.name} is part of an expense or payment, so they can't be removed.`)
    await db.members.put({ ...m, deleted: true, updated_at: nextStamp(m.updated_at), dirty: 1 })
  })
  changed(null)
}

// ---------- Expenses ----------

export interface ExpenseInput {
  title: string
  amount_minor: number
  paid_by: string
  spent_at: string
  notes: string
  shares: Share[]
}

export async function saveExpense(tripId: string, id: string | null, input: ExpenseInput): Promise<string> {
  const total = input.shares.reduce((t, s) => t + s.amount_minor, 0)
  if (total !== input.amount_minor) throw new ValidationError('Shares must add up to the amount.')
  if (!input.title.trim()) throw new ValidationError('Enter what it was for.')
  const finalId = id ?? uuid()
  await db.transaction('rw', db.expenses, async () => {
    const prev = id ? await db.expenses.get(id) : undefined
    const row: Expense = {
      id: finalId,
      trip_id: tripId,
      title: input.title.trim(),
      amount_minor: input.amount_minor,
      paid_by: input.paid_by,
      spent_at: input.spent_at,
      notes: input.notes.trim(),
      shares: input.shares,
      updated_at: nextStamp(prev?.updated_at),
      deleted: false,
      dirty: 1,
    }
    await db.expenses.put(row)
  })
  return changed(finalId)
}

export async function deleteExpense(id: string) {
  await db.transaction('rw', db.expenses, async () => {
    const e = await db.expenses.get(id)
    if (!e) return
    await db.expenses.put({ ...e, deleted: true, updated_at: nextStamp(e.updated_at), dirty: 1 })
  })
  changed(null)
}

// ---------- Settlements ----------

export async function addSettlement(tripId: string, from: string, to: string, amount_minor: number) {
  if (amount_minor <= 0) throw new ValidationError('Amount must be positive.')
  const now = new Date().toISOString()
  const row: Settlement = {
    id: uuid(),
    trip_id: tripId,
    from_member: from,
    to_member: to,
    amount_minor,
    paid_at: now,
    updated_at: nextStamp(),
    deleted: false,
    dirty: 1,
  }
  await db.settlements.add(row)
  return changed(row.id)
}

export async function undoSettlement(id: string) {
  await db.transaction('rw', db.settlements, async () => {
    const s = await db.settlements.get(id)
    if (!s) return
    await db.settlements.put({ ...s, deleted: true, updated_at: nextStamp(s.updated_at), dirty: 1 })
  })
  changed(null)
}
