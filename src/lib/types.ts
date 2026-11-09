/** Fields every synced row has. `dirty` exists only on the phone (1 = waiting to upload). */
export interface SyncFields {
  id: string
  updated_at: string // ISO timestamp of this phone's last edit; newest edit wins
  deleted: boolean
  dirty?: 0 | 1
}

export interface Trip extends SyncFields {
  name: string
  currency: string
  created_at: string
}

export interface Member extends SyncFields {
  trip_id: string
  name: string
}

export interface Share {
  member_id: string
  amount_minor: number
}

export interface Expense extends SyncFields {
  trip_id: string
  title: string
  amount_minor: number
  paid_by: string
  spent_at: string
  notes: string
  shares: Share[]
}

export interface Settlement extends SyncFields {
  trip_id: string
  from_member: string
  to_member: string
  amount_minor: number
  paid_at: string
}

export type TableName = 'trips' | 'members' | 'expenses' | 'settlements'

/** Parent → child order. Push and pull both follow it so foreign keys are satisfied. */
export const TABLES: TableName[] = ['trips', 'members', 'expenses', 'settlements']
