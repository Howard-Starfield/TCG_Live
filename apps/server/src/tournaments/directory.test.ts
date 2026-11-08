import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DirectoryInputError, parseDraft, parseDetails, searchQuery } from './directory.js';

test('live details require an explicit game and title and bound the plain-text description', () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const value = { name: '  Autumn Cup ', game: 'pokemon', description: 'Bring a camera.\nCheck in later.' };
  assert.deepEqual(parseDetails(eventId, value), { ...value, name: 'Autumn Cup' });
  for (const invalid of [ { ...value, game: null }, { ...value, name: '' }, { ...value, name: undefined },
    { ...value, description: 'x'.repeat(501) }, { ...value, description: 'hidden\u0000' }, { ...value, rules: 'invented' } ])
    assert.throws(() => parseDetails(eventId, invalid), DirectoryInputError);
  assert.throws(() => parseDetails('../path', value), DirectoryInputError);
});

test('draft inputs use a safe game default and reject paths, controls and unknown fields', () => {
  const draftId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(parseDraft({ draftId, game: 'pokemon' }),
    { draftId, game: 'pokemon', name: 'Pokémon Tournament' });
  assert.equal(parseDraft({ draftId, game: 'one-piece', name: '  Grand Line  ' }).name, 'Grand Line');
  assert.throws(() => parseDraft({ draftId, game: 'unknown' }), DirectoryInputError);
  assert.throws(() => parseDraft({ draftId, game: 'pokemon', name: '../secret\u0000' }), DirectoryInputError);
  assert.throws(() => parseDraft({ draftId, game: 'pokemon', path: 'C:\\secret' }), DirectoryInputError);
  assert.throws(() => parseDraft({ draftId, game: 'pokemon', name: 'x'.repeat(81) }), DirectoryInputError);
});

test('search makes bounded parameter values with prefix lexemes', () => {
  assert.equal(searchQuery('Pokémon active'), 'pokemon:* & active:*');
  assert.equal(searchQuery('北風 大会'), '北風:* & 大会:*');
  assert.equal(searchQuery('Øresund'), 'øresund:*');
  assert.equal(searchQuery('onepiece'), 'onepiece:*');
  assert.equal(searchQuery('  '), null);
  assert.equal(searchQuery("foo' | !bar"), 'foo:* & bar:*');
  assert.throws(() => searchQuery('!'), DirectoryInputError);
  assert.throws(() => searchQuery('x'.repeat(121)), DirectoryInputError);
  assert.throws(() => searchQuery(Array.from({ length: 13 }, () => 'word').join(' ')), DirectoryInputError);
});
