import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_TOOLS_AUDIT_KINDS } from './admin-tools-contract.js';
import { MATCH_ROOMS_AUDIT_KINDS, MATCH_ROOM_DEFAULT_TEMPLATE, MATCH_ROOM_LIMITS, MATCH_ROOM_TEMPLATE_PRESETS,
  categoryRangeForTable, overflowCategoryName, renderMatchRoomName, sanitizeEventName, validMatchRoomName,
  validateMatchRoomTemplate, type MatchRoomNameContext } from './match-rooms-contract.js';

const ctx: MatchRoomNameContext = { matchId: 'M3', table: 3, round: 1, eventName: 'Spring Cup', gameLabel: 'One Piece' };

test('the default template and every preset are valid', () => {
  assert.equal(validateMatchRoomTemplate(MATCH_ROOM_DEFAULT_TEMPLATE), null);
  for (const preset of MATCH_ROOM_TEMPLATE_PRESETS) assert.equal(validateMatchRoomTemplate(preset), null, preset);
});

test('templates render every token', () => {
  assert.equal(renderMatchRoomName('🎮 {match}', ctx), '🎮 M3');
  assert.equal(renderMatchRoomName('{table} · {round}', ctx), 'Table 3 · Round 1');
  assert.equal(renderMatchRoomName('⚔️ {round} · {match}', ctx), '⚔️ Round 1 · M3');
  assert.equal(renderMatchRoomName('{n} {event} {game}', ctx), '3 Spring Cup One Piece');
  assert.equal(renderMatchRoomName('{n} {game}', { ...ctx, gameLabel: null }), '3 TCG');
});

test('unknown tokens, stray braces and templates without a match number are refused', () => {
  assert.match(validateMatchRoomTemplate('{match} {bogus}') ?? '', /Unknown token \{bogus\}/);
  assert.match(validateMatchRoomTemplate('{match} {Match}') ?? '', /Unknown token/);
  assert.match(validateMatchRoomTemplate('{match') ?? '', /Unmatched/);
  assert.match(validateMatchRoomTemplate('Room') ?? '', /\{match\}, \{n\} or \{table\}/);
  assert.match(validateMatchRoomTemplate('{round} {event}') ?? '', /\{match\}, \{n\} or \{table\}/);
  assert.ok(validateMatchRoomTemplate('   '));
  assert.ok(validateMatchRoomTemplate('{match}\n{n}'));
});

test('{stage} is refused with "coming with brackets"', () => {
  assert.match(validateMatchRoomTemplate('{match} {stage}') ?? '', /coming with brackets/);
});

test('a worst-case render over 100 characters is refused, in code points and in UTF-16 units', () => {
  assert.match(validateMatchRoomTemplate('{event} {game} {event} {match}') ?? '', /100 characters/);
  assert.equal(validateMatchRoomTemplate('{event} {game} {match}'), null);
  // 49 astral emoji are 49 code points but 98 UTF-16 units; the fixed text pushes the units past 100 first.
  const emoji = '😀'.repeat(46);
  assert.ok([...`${emoji} {match}`].length < 100);
  assert.match(validateMatchRoomTemplate(`${emoji} {event} {match}`) ?? '', /100 characters/);
  assert.equal(validateMatchRoomTemplate(`${'😀'.repeat(20)} {match}`), null);
});

test('an empty render falls back to "Match {n}"', () => {
  assert.equal(renderMatchRoomName('{event}', { ...ctx, eventName: null }), 'Match 3');
  assert.equal(renderMatchRoomName('{event}', { ...ctx, eventName: '  \n ' }), 'Match 3');
});

test('a render is never longer than the channel name limit', () => {
  const name = renderMatchRoomName('{event}{event}{event}{event}', { ...ctx, eventName: 'x'.repeat(100) });
  assert.ok(name.length <= MATCH_ROOM_LIMITS.nameLength);
});

test('sanitizeEventName strips control characters, collapses spaces and clips with an ellipsis', () => {
  assert.equal(sanitizeEventName(null), '');
  assert.equal(sanitizeEventName('  Spring\n\tCup   2026\u0000 '), 'Spring Cup 2026');
  const clipped = sanitizeEventName('a'.repeat(60));
  assert.equal([...clipped].length, MATCH_ROOM_LIMITS.eventNameLength);
  assert.ok(clipped.endsWith('…'));
  assert.equal(sanitizeEventName('b'.repeat(40)), 'b'.repeat(40));
});

test('validMatchRoomName accepts 1 to 100 readable characters', () => {
  assert.equal(validMatchRoomName('Final table'), null);
  assert.ok(validMatchRoomName('   '));
  assert.ok(validMatchRoomName('a\nb'));
  assert.ok(validMatchRoomName('a'.repeat(101)));
  assert.equal(validMatchRoomName('a'.repeat(100)), null);
  assert.ok(validMatchRoomName('😀'.repeat(60)));
});

test('overflowCategoryName uses an en dash and falls back to TCG', () => {
  assert.equal(overflowCategoryName('One Piece', 51, 100), 'One Piece 51–100');
  assert.equal(overflowCategoryName(null, 1, 50), 'TCG 1–50');
  assert.equal(overflowCategoryName('   ', 101, 150), 'TCG 101–150');
});

test('categoryRangeForTable groups tables in blocks of 50', () => {
  assert.deepEqual(categoryRangeForTable(1), { index: 0, from: 1, to: 50 });
  assert.deepEqual(categoryRangeForTable(50), { index: 0, from: 1, to: 50 });
  assert.deepEqual(categoryRangeForTable(51), { index: 1, from: 51, to: 100 });
  assert.deepEqual(categoryRangeForTable(500), { index: 9, from: 451, to: 500 });
});

test('match room audit kinds are spread into the admin tools audit kinds and are well formed', () => {
  assert.equal(MATCH_ROOMS_AUDIT_KINDS.length, 9);
  for (const kind of MATCH_ROOMS_AUDIT_KINDS) {
    assert.ok(ADMIN_TOOLS_AUDIT_KINDS.includes(kind), kind);
    assert.match(kind, /^[a-z][a-z_.]{2,63}$/);
  }
  assert.equal(new Set(ADMIN_TOOLS_AUDIT_KINDS).size, ADMIN_TOOLS_AUDIT_KINDS.length);
});
