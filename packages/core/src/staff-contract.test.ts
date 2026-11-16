import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISCORD_ROLE_COLOR_PRESETS, RULING_ACTIONS, STAFF_ACTIONS, TOURNAMENT_ROLE_DEFAULTS, TOURNAMENT_ROLE_KINDS, staffMay,
  type StaffAction } from './staff-contract.js';

const JUDGE_YES: StaffAction[] = ['checkinFor', 'resolve', 'correct', 'judgeResume', 'judgeClose', 'evidenceSubmit', 'evidenceReply'];
const JUDGE_NO: StaffAction[] = ['publish', 'delayStart', 'signupClose', 'signupReopen', 'signupRemove', 'signupAdd', 'refresh', 'moderation'];

test('staffMay: an organizer may do every staff action', () => {
  for (const action of STAFF_ACTIONS) assert.equal(staffMay('organizer', action), true, action);
});

test('staffMay: a judge may do rulings, check-in-for and evidence only', () => {
  for (const action of JUDGE_YES) assert.equal(staffMay('judge', action), true, action);
  for (const action of JUDGE_NO) assert.equal(staffMay('judge', action), false, action);
  assert.equal(JUDGE_YES.length + JUDGE_NO.length, STAFF_ACTIONS.length);
});

test('RULING_ACTIONS are exactly the five rulings and are all judge-permitted', () => {
  assert.deepEqual([...RULING_ACTIONS].sort(), ['correct', 'evidenceReply', 'judgeClose', 'judgeResume', 'resolve']);
  for (const action of RULING_ACTIONS) assert.equal(staffMay('judge', action), true);
});

test('role defaults and colour presets', () => {
  assert.deepEqual(TOURNAMENT_ROLE_KINDS, ['organizer', 'judge']);
  assert.deepEqual(TOURNAMENT_ROLE_DEFAULTS.organizer, { name: 'TCG Organizer', color: 0xE67E22 });
  assert.deepEqual(TOURNAMENT_ROLE_DEFAULTS.judge, { name: 'TCG Judge', color: 0x3498DB });
  assert.equal(DISCORD_ROLE_COLOR_PRESETS.length, 20);
  assert.equal(new Set(DISCORD_ROLE_COLOR_PRESETS).size, 20);
  for (const color of DISCORD_ROLE_COLOR_PRESETS) assert.ok(Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF);
});
