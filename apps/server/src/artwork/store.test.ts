import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtworkStore } from './store.js';
import { setVisualArtworkStore, visualBanner, visualFile, visualThumbnail } from '../discord/visuals.js';
import { renderCard } from '../discord/cards.js';
import { createFixture } from '../rehearsal/domain.js';

const packaged = fileURLToPath(new URL('../../assets/games/one-piece/gifs/tournament.gif', import.meta.url));

test('game artwork persists independently and falls back when a selected upload disappears', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-artwork-test-'));
  assert.equal(path.dirname(directory), tmpdir());
  try {
    let store = await ArtworkStore.open(directory);
    assert.equal(store.describe().activeGame, null);
    assert.equal(store.describe().games['one-piece'].banner.source, 'default');
    assert.equal(store.describe().games.pokemon.thumbnail.source, 'none');
    const gif = await readFile(packaged);
    await store.upload('one-piece', 'thumbnail', gif, 'image/gif');
    await store.selectGame('one-piece');
    const filename = store.resolveActive('thumbnail')!.filename;
    assert.match(filename, /^one-piece-thumbnail-[a-f0-9]{64}\.gif$/);
    assert.equal(store.resolve('pokemon', 'thumbnail'), null);
    store = await ArtworkStore.open(directory);
    assert.equal(store.describe().activeGame, 'one-piece');
    assert.equal(store.resolveActive('thumbnail')?.filename, filename);
    setVisualArtworkStore(store);
    assert.equal(visualThumbnail('error').url, `attachment://${filename}`);
    assert.equal(visualBanner()?.url, 'attachment://one-piece-tournament.gif');
    const card = renderCard(createFixture('11111111-1111-4111-8111-111111111111'), 'checkin');
    assert.equal(card.embeds[0]?.image?.url, 'attachment://one-piece-tournament.gif');
    assert.equal(card.embeds[0]?.thumbnail, undefined);
    assert.ok(visualFile(filename)?.attachment.endsWith(filename));
    await unlink(store.resolveActive('thumbnail')!.path);
    assert.equal(store.describe().games['one-piece'].thumbnail.source, 'none');
    assert.equal(visualThumbnail('error').url, 'attachment://tcg-error-v1.png');
  } finally {
    setVisualArtworkStore(null);
    await rm(directory, { recursive: true, force: true });
  }
});

test('uploads reject fake, mismatched, truncated and oversized artwork without changing selection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-artwork-test-'));
  assert.equal(path.dirname(directory), tmpdir());
  try {
    const store = await ArtworkStore.open(directory);
    const gif = await readFile(packaged);
    await assert.rejects(store.upload('pokemon', 'banner', Buffer.from('<svg/>'), 'image/gif'));
    await assert.rejects(store.upload('pokemon', 'banner', gif, 'image/png'));
    await assert.rejects(store.upload('pokemon', 'banner', gif.subarray(0, -1), 'image/gif'));
    await assert.rejects(store.upload('pokemon', 'banner', Buffer.alloc(4 * 1024 * 1024 + 1), 'image/png'));
    assert.equal(store.describe().games.pokemon.banner.source, 'default');
    await store.upload('pokemon', 'banner', gif, 'image/gif');
    assert.equal(store.describe().games.pokemon.banner.source, 'custom');
    await store.reset('pokemon', 'banner');
    assert.equal(store.describe().games.pokemon.banner.source, 'default');
    const malformed = '{"version":1,"activeGame":"../escape","games":{}}';
    await writeFile(path.join(directory, 'profile.json'), malformed);
    const recovered = await ArtworkStore.open(directory);
    assert.equal(recovered.describe().activeGame, null);
    assert.match(recovered.describe().loadIssue ?? '', /invalid/);
    assert.equal(await readFile(path.join(directory, 'profile.json'), 'utf8'), malformed);
    await recovered.selectGame('one-piece');
    assert.equal(recovered.describe().loadIssue, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
