import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tournamentRoutes } from './routes.js';
import { DirectoryConflictError, type TournamentDirectory } from './directory.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const details = { eventId, name: 'Autumn Cup', game: 'pokemon' as const, description: 'Bring a camera.', configured: true };

test('details save retains successful persistence when Discord delivery fails; rejected saves never apply', async () => {
  let saves = 0;
  let applies = 0;
  let reject = false;
  const directory: TournamentDirectory = {
    async list() { return { entries: [], defaultGame: 'pokemon' }; },
    async createDraft() { throw Error('not used'); },
    async getDetails() { return details; },
    async saveDetails(id) { assert.equal(id, eventId); if (reject) throw new DirectoryConflictError('Only the active tournament can be edited.'); saves++; return details; }
  };
  const routes = tournamentRoutes(directory, () => 'pokemon', async game => {
    assert.equal(game, 'pokemon'); applies++; throw Error('private network detail');
  });
  const route = routes.find(item => item.pattern.test(`/api/v1/tournaments/${eventId}/details`))!;
  const invoke = async (method: 'GET' | 'PUT') => {
    const request = Readable.from(method === 'PUT' ? [Buffer.from('{}')] : []) as IncomingMessage;
    request.headers = { 'content-type': 'application/json' };
    let body = '';
    const response = { headersSent: false, writableEnded: false, destroyed: false,
      writeHead() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
    await route.methods[method]!.run({ request, response, query: new URLSearchParams(), params: [eventId] });
    return JSON.parse(body);
  };
  const saved = await invoke('PUT');
  assert.equal(saves, 1);
  assert.equal(saved.applyStatus, 'pending');
  assert.doesNotMatch(saved.applyMessage, /private network/);
  assert.equal((await invoke('GET')).applyStatus, undefined);
  reject = true;
  await assert.rejects(invoke('PUT'), /Only the active tournament/);
  assert.equal(applies, 1);
});
