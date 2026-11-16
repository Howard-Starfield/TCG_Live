import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAFF_ACTIONS } from '@tcg-live/core';
import * as staffModule from './staff.js';
import { judgeDenied, memberRoleIds, resolveStaff, rulingConflictText, STAFF_DENIED,
  type StaffSources } from './staff.js';

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const USER = '200000000000000002';
const ORG_ROLE = '300000000000000001';
const JUDGE_ROLE = '300000000000000002';
const LEGACY_ROLE = '300000000000000003';
const sources: StaffSources = { roles: { guildId: GUILD, organizerRoleId: ORG_ROLE, judgeRoleId: JUDGE_ROLE }, legacyStaffRoleIds: [LEGACY_ROLE] };
const subject = (roleIds: string[], userId = USER, ownerId: string | null = OWNER) => ({ userId, roleIds, ownerId });

test('resolveStaff: the owner is organizer via owner, with or without roles', () => {
  assert.deepEqual(resolveStaff(subject([], OWNER), sources), { role: 'organizer', via: 'owner' });
  assert.deepEqual(resolveStaff(subject([JUDGE_ROLE], OWNER), sources), { role: 'organizer', via: 'owner' });
});

test('resolveStaff: organizer role, judge role, legacy staff role', () => {
  assert.deepEqual(resolveStaff(subject([ORG_ROLE]), sources), { role: 'organizer', via: 'role', roleId: ORG_ROLE });
  assert.deepEqual(resolveStaff(subject([JUDGE_ROLE]), sources), { role: 'judge', via: 'role', roleId: JUDGE_ROLE });
  assert.deepEqual(resolveStaff(subject([LEGACY_ROLE]), sources), { role: 'judge', via: 'legacy-staff-role', roleId: LEGACY_ROLE });
});

test('resolveStaff: precedence is organizer, then judge, then legacy', () => {
  assert.equal(resolveStaff(subject([JUDGE_ROLE, ORG_ROLE]), sources)?.role, 'organizer');
  assert.deepEqual(resolveStaff(subject([LEGACY_ROLE, JUDGE_ROLE]), sources), { role: 'judge', via: 'role', roleId: JUDGE_ROLE });
  assert.deepEqual(resolveStaff(subject([LEGACY_ROLE, ORG_ROLE]), sources), { role: 'organizer', via: 'role', roleId: ORG_ROLE });
});

test('resolveStaff: a role that is both legacy and Judge is judge via role', () => {
  const both: StaffSources = { ...sources, legacyStaffRoleIds: [JUDGE_ROLE] };
  assert.deepEqual(resolveStaff(subject([JUDGE_ROLE]), both), { role: 'judge', via: 'role', roleId: JUDGE_ROLE });
});

test('resolveStaff: nobody else is staff, and there is no organizer-id source', () => {
  assert.equal(resolveStaff(subject([]), sources), null);
  assert.equal(resolveStaff(subject(['300000000000000099']), sources), null);
  assert.equal(resolveStaff({ userId: USER, roleIds: [], ownerId: null }, sources), null);
});

test('resolveStaff: unreadable sources leave only the owner', () => {
  const none: StaffSources = { roles: null, legacyStaffRoleIds: [] };
  assert.deepEqual(resolveStaff(subject([], OWNER), none), { role: 'organizer', via: 'owner' });
  assert.equal(resolveStaff(subject([ORG_ROLE, JUDGE_ROLE, LEGACY_ROLE]), none), null);
  const uncreated: StaffSources = { roles: { guildId: GUILD, organizerRoleId: null, judgeRoleId: null }, legacyStaffRoleIds: [] };
  assert.equal(resolveStaff(subject([ORG_ROLE]), uncreated), null);
  assert.equal(resolveStaff({ userId: OWNER, roleIds: [], ownerId: null }, none), null);
});

test('memberRoleIds drops @everyone from a cached member', () => {
  const cached = { guild: { id: GUILD }, roles: { cache: new Map([[GUILD, {}], [JUDGE_ROLE, {}]]) } };
  assert.deepEqual(memberRoleIds(cached), [JUDGE_ROLE]);
  assert.deepEqual(memberRoleIds({ roles: [ORG_ROLE] }), [ORG_ROLE]);
  assert.deepEqual(memberRoleIds(null), []);
});

test('denial texts', () => {
  assert.match(STAFF_DENIED, /Only the organizer or tournament staff.*TCG Organizer/);
  for (const action of STAFF_ACTIONS) assert.ok(judgeDenied(action).length > 0, action);
  assert.match(judgeDenied('publish'), /publish/);
  assert.equal(rulingConflictText('M2', false), 'You are playing in M2, so another organizer or judge must rule on it.');
  assert.match(rulingConflictText('M2', true), /Add a TCG Judge in Admin tools > Settings > Tournament roles\.$/);
});

test('the adminId-honouring isTournamentStaff wrapper is gone: the organizer ID is not a staff source', () => {
  assert.equal('isTournamentStaff' in staffModule, false);
  assert.equal(resolveStaff({ userId: USER, roleIds: [], ownerId: OWNER }, { roles: null, legacyStaffRoleIds: [] }), null);
});

test('resolveStaff returns the matched role ID (none for the owner)', () => {
  const sources: StaffSources = { roles: { guildId: GUILD, organizerRoleId: ORG_ROLE, judgeRoleId: JUDGE_ROLE }, legacyStaffRoleIds: [LEGACY_ROLE] };
  assert.equal(resolveStaff({ userId: USER, roleIds: [LEGACY_ROLE], ownerId: OWNER }, sources)?.roleId, LEGACY_ROLE);
  assert.equal(resolveStaff({ userId: USER, roleIds: [JUDGE_ROLE, LEGACY_ROLE], ownerId: OWNER }, sources)?.roleId, JUDGE_ROLE);
  assert.equal(resolveStaff({ userId: OWNER, roleIds: [ORG_ROLE], ownerId: OWNER }, sources)?.roleId, undefined);
});
