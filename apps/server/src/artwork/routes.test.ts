import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArtworkProfileDto } from '@tcg-live/core';
import { artworkRoutes, type ArtworkRoute } from './routes.js';
import { ArtworkStore } from './store.js';

async function invoke(routes: ArtworkRoute[], method: 'GET' | 'PUT' | 'DELETE', pathname: string,
  payload?: Buffer, type?: string): Promise<ArtworkProfileDto> {
  const route = routes.map(item => ({ item, match: item.pattern.exec(pathname) })).find(item => item.match);
  assert(route?.match);
  const endpoint = route.item.methods[method];
  assert(endpoint);
  const request = Readable.from(payload ? [payload] : []) as IncomingMessage;
  request.headers = { ...(payload ? { 'content-length': String(payload.length) } : {}),
    ...(type ? { 'content-type': type } : {}) };
  let body = '';
  let headersSent = false;
  let writableEnded = false;
  const response = { get headersSent() { return headersSent; }, destroyed: false,
    get writableEnded() { return writableEnded; },
    writeHead() { headersSent = true; }, end(value?: string) { body = value ?? ''; writableEnded = true; } } as unknown as ServerResponse;
  await endpoint.run({ request, response, params: route.match.slice(1) });
  return JSON.parse(body) as ArtworkProfileDto;
}

test('artwork mutations apply active selections and leave inactive uploads unapplied', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-artwork-routes-'));
  assert.equal(path.dirname(directory), tmpdir());
  try {
    const store = await ArtworkStore.open(directory);
    let applies = 0;
    const routes = artworkRoutes(store, async () => { applies++; return { status: 'applied' }; });
    const select = await invoke(routes, 'PUT', '/api/v1/artwork/active-game',
      Buffer.from('{"game":"one-piece"}'), 'application/json');
    assert.equal(select.applyStatus, 'applied');
    assert.equal(applies, 1);
    const gif = await readFile(fileURLToPath(new URL('../../assets/games/pokemon/gifs/tournament.gif', import.meta.url)));
    const inactive = await invoke(routes, 'PUT', '/api/v1/artwork/pokemon/banner', gif, 'image/gif');
    assert.equal(inactive.applyStatus, 'inactive');
    assert.equal(applies, 1);
    const active = await invoke(routes, 'PUT', '/api/v1/artwork/one-piece/thumbnail', gif, 'image/gif');
    assert.equal(active.applyStatus, 'applied');
    assert.equal(applies, 2);
    const reset = await invoke(routes, 'DELETE', '/api/v1/artwork/one-piece/thumbnail');
    assert.equal(reset.applyStatus, 'applied');
    assert.equal(applies, 3);
    const cleared = await invoke(routes, 'PUT', '/api/v1/artwork/active-game',
      Buffer.from('{"game":null}'), 'application/json');
    assert.equal(cleared.applyStatus, 'applied');
    assert.equal(applies, 4);
    const profile = await invoke(routes, 'GET', '/api/v1/artwork');
    assert.equal(profile.applyStatus, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed or unavailable panel callback leaves the saved choice and reports pending only on mutations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-artwork-routes-'));
  assert.equal(path.dirname(directory), tmpdir());
  try {
    const store = await ArtworkStore.open(directory);
    const thrown = artworkRoutes(store, async () => { throw new Error('Discord connection lost'); });
    const selected = await invoke(thrown, 'PUT', '/api/v1/artwork/active-game',
      Buffer.from('{"game":"pokemon"}'), 'application/json');
    assert.equal(selected.activeGame, 'pokemon');
    assert.equal(selected.applyStatus, 'pending');
    assert.doesNotMatch(selected.applyMessage ?? '', /connection lost/i, 'internal error is not exposed');
    const saved = await invoke(thrown, 'GET', '/api/v1/artwork');
    assert.equal(saved.activeGame, 'pokemon');
    assert.equal(saved.applyStatus, undefined);
    assert.equal(saved.applyMessage, undefined);
    const pending = artworkRoutes(store, async () => ({ status: 'pending', message: 'One or more existing panels could not be updated.' }));
    const retried = await invoke(pending, 'PUT', '/api/v1/artwork/active-game',
      Buffer.from('{"game":"pokemon"}'), 'application/json');
    assert.equal(retried.applyStatus, 'pending');
    assert.match(retried.applyMessage ?? '', /existing panels/);
    const noCallback = artworkRoutes(store);
    const cleared = await invoke(noCallback, 'PUT', '/api/v1/artwork/active-game',
      Buffer.from('{"game":null}'), 'application/json');
    assert.equal(cleared.activeGame, null);
    assert.equal(cleared.applyStatus, 'pending');
    assert.equal((await invoke(noCallback, 'GET', '/api/v1/artwork')).applyStatus, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
