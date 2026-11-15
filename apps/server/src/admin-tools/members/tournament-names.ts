// Tournament names for a member profile's history: the directory (drafts and named signup tournaments)
// names events by ID. PostgreSQL storage reads tcg_tournament_directory; memory storage (demo, tests)
// names nothing, so the dashboard falls back to its own label. Never throws: a name is a nicety.
import type { TournamentHistoryRefDto } from '@tcg-live/core';
import { withClient } from '../../rehearsal/store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Looks up names by event ID; injectable for tests. */
export type TournamentNameLookup = (eventIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

export const pgTournamentNames: TournamentNameLookup = async eventIds => {
  const ids = eventIds.filter(id => UUID.test(id)).map(id => id.toLowerCase());
  if (!ids.length) return new Map();
  return withClient(async client => {
    const exists = await client.query<{ name: string | null }>(`SELECT to_regclass('public.tcg_tournament_directory')::text AS name`);
    if (!exists.rows[0]?.name) return new Map();
    const result = await client.query<{ id: string; name: string | null }>(
      'SELECT id::text AS id, name FROM public.tcg_tournament_directory WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(result.rows.filter(row => row.name).map(row => [row.id.toLowerCase(), row.name!]));
  });
};

/** Returns `refs` with `name` filled from the lookup where one is known. */
export async function withTournamentNames(refs: TournamentHistoryRefDto[], storage: 'postgres' | 'memory',
  lookup: TournamentNameLookup = pgTournamentNames): Promise<TournamentHistoryRefDto[]> {
  if (!refs.length || (storage !== 'postgres' && lookup === pgTournamentNames)) return refs;
  let names: ReadonlyMap<string, string>;
  try { names = await lookup(refs.map(ref => ref.eventId)); } catch { return refs; }
  return refs.map(ref => ({ ...ref, name: names.get(ref.eventId.toLowerCase()) ?? ref.name }));
}
