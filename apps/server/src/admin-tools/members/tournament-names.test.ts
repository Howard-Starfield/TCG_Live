import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TournamentHistoryRefDto } from '@tcg-live/core';
import { withTournamentNames } from './tournament-names.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const refs: TournamentHistoryRefDto[] = [
  { eventId: A, name: null, status: 'retired', createdAtMs: 1, role: 'player' },
  { eventId: B, name: null, status: 'active', createdAtMs: 2, role: 'roster' }
];

test('member history gets directory names by event ID; unknown, failing or memory lookups leave null', async () => {
  const named = await withTournamentNames(refs, 'postgres', async ids => {
    assert.deepEqual(ids, [A, B]);
    return new Map([[A, 'Friday Locals']]);
  });
  assert.deepEqual(named.map(ref => ref.name), ['Friday Locals', null]);
  assert.deepEqual((await withTournamentNames(refs, 'postgres', async () => { throw new Error('down'); })).map(ref => ref.name), [null, null]);
  // Memory storage never touches PostgreSQL with the default lookup.
  assert.deepEqual((await withTournamentNames(refs, 'memory')).map(ref => ref.name), [null, null]);
  assert.deepEqual(await withTournamentNames([], 'postgres'), []);
});
