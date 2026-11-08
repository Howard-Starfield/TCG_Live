import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setupPrivateDiscordSchema, withClient } from '../rehearsal/store.js';
import { DirectoryConflictError, pgTournamentDirectory, requireDirectorySchema, setupTournamentDirectory } from './directory.js';

test('native directory draft is idempotent and full-text searchable without touching event rows', async () => {
  const draftId = randomUUID();
  const directory = pgTournamentDirectory(() => true);
  assert.match(await setupPrivateDiscordSchema(), /^(upgraded|already_ready)$/);
  assert.match(await setupTournamentDirectory(), /^(created|already_ready)$/);
  await withClient(requireDirectorySchema);
  try {
    const created = await directory.createDraft({ draftId, game: 'pokemon', name: 'Pokémon Autumn Cup' });
    assert.equal(created.status, 'draft');
    assert.equal(created.kind, 'signup');
    assert.equal(created.game, 'pokemon');
    assert.deepEqual(await directory.createDraft({ draftId, game: 'pokemon', name: 'Pokémon Autumn Cup' }), created);
    await assert.rejects(directory.createDraft({ draftId, game: 'pokemon', name: 'Different' }), DirectoryConflictError);
    const found = await directory.list('pokemon aut draft', 'one-piece');
    assert.equal(found.defaultGame, 'one-piece');
    assert(found.entries.some((row: { eventId: string }) => row.eventId === draftId));
    const byStatus = await directory.list('draft', 'pokemon');
    assert(byStatus.entries.some((row: { eventId: string }) => row.eventId === draftId));
    const byOther = await directory.list('onepiece', 'pokemon');
    assert(!byOther.entries.some((row: { eventId: string }) => row.eventId === draftId));
    const historical = await withClient(async client => {
      const result = await client.query<{ event_id: string; status: 'active' | 'retired'; kind: string | null }>(
        "SELECT event_id::text AS event_id, status, identity_map->>'kind' AS kind FROM public.tcg_rehearsal_sessions ORDER BY created_at_ms DESC LIMIT 1");
      return result.rows[0] ?? null;
    });
    if (historical) {
      const byHistoryStatus = await directory.list(historical.status, 'pokemon');
      assert(byHistoryStatus.entries.some((row: { eventId: string }) => row.eventId === historical.event_id));
      const byHistoryKind = await directory.list(historical.kind ?? 'legacy', 'pokemon');
      assert(byHistoryKind.entries.some((row: { eventId: string }) => row.eventId === historical.event_id));
    }
  } finally {
    await withClient(client => client.query('DELETE FROM public.tcg_tournament_directory WHERE id = $1', [draftId]));
  }
});
