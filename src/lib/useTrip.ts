import { db } from './db'
import type { Expense, Member, Settlement, Trip } from './types'
import { useLocalQuery } from './useLocalQuery'

export interface TripData {
  trip: Trip | null
  /** All members, including removed ones (needed for names in history). */
  allMembers: Member[]
  members: Member[]
  expenses: Expense[]
  settlements: Settlement[]
}

/** Everything for one trip, live from Dexie. undefined while loading. */
export function useTrip(tripId: string): TripData | undefined {
  return useLocalQuery(async () => {
    const [trip, allMembers, expenses, settlements] = await Promise.all([
      db.trips.get(tripId),
      db.members.where('trip_id').equals(tripId).toArray(),
      db.expenses.where('trip_id').equals(tripId).toArray(),
      db.settlements.where('trip_id').equals(tripId).toArray(),
    ])
    allMembers.sort((a, b) => a.name.localeCompare(b.name))
    return {
      trip: trip && !trip.deleted ? trip : null,
      allMembers,
      members: allMembers.filter((m) => !m.deleted),
      expenses: expenses.filter((e) => !e.deleted),
      settlements: settlements.filter((s) => !s.deleted),
    }
  }, [tripId])
}

export function memberName(members: Member[], id: string): string {
  const m = members.find((x) => x.id === id)
  if (!m) return 'Unknown'
  return m.deleted ? `${m.name} (removed)` : m.name
}
