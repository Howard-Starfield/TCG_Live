import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto } from '@tcg-live/core';
import { LOCAL_ADMIN, MemoryOpsAuditStore } from '../ops/audit.js';
import { OpsInputError } from '../ops/errors.js';
import { MemoryAdminCounters } from './schema.js';
import { AdminToolsVersionConflictError, MemoryAdminToolsSettingsStore, parseAdminToolsSettings, reservedChannelProblem } from './settings.js';
import { embed, emojiOrNull, messageBody, reason } from './validate.js';

const guild = '123456789012345678';
const channel = '223456789012345678';
const defaults = () => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;

test('the default settings parse unchanged and unknown or missing fields are refused', () => {
  assert.deepEqual(parseAdminToolsSettings(defaults()), defaults());
  assert.throws(() => parseAdminToolsSettings({ ...defaults(), extra: 1 }), OpsInputError);
  const { cases: _cases, ...missing } = defaults();
  assert.throws(() => parseAdminToolsSettings(missing), OpsInputError);
  const badPattern = defaults();
  badPattern.tickets.namingPattern = 'ticket {name}';
  assert.throws(() => parseAdminToolsSettings(badPattern), /must include \{n\}/);
  const twoTickets = defaults() as unknown as { tickets: { maxOpenPerUser: number } };
  twoTickets.tickets.maxOpenPerUser = 2;
  assert.throws(() => parseAdminToolsSettings(twoTickets), /one open ticket/);
  const enabledIncomplete = defaults();
  enabledIncomplete.tickets.enabled = true;
  assert.throws(() => parseAdminToolsSettings(enabledIncomplete), /support channel/);
  const roles = defaults();
  roles.logging.autoRole = { enabled: true, roleIds: [channel, channel] };
  assert.deepEqual(parseAdminToolsSettings(roles).logging.autoRole.roleIds, [channel], 'IDs are de-duplicated');
});

test('the ticket panel may not live on a reserved tournament channel', () => {
  const settings = defaults();
  settings.tickets.supportChannelId = channel;
  assert.match(reservedChannelProblem(settings, new Set([channel])) ?? '', /signup channel/);
  assert.equal(reservedChannelProblem(settings, new Set()), null);
});

test('the memory store versions saves, refuses stale ones with the current state and audits sections', async () => {
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryAdminToolsSettingsStore(audit, () => 1_000);
  assert.equal((await store.get(guild)).version, 0);
  const next = defaults();
  next.cases.dmMembers = false;
  const saved = await store.put(guild, 0, next, LOCAL_ADMIN);
  assert.equal(saved.version, 1);
  assert.equal(saved.updatedAtMs, 1_000);
  await assert.rejects(store.put(guild, 0, next, LOCAL_ADMIN), (error: unknown) =>
    error instanceof AdminToolsVersionConflictError && error.current.version === 1);
  await assert.rejects(store.get('not-a-guild'), OpsInputError);
  assert.deepEqual(audit.entries.map(entry => [entry.kind, entry.payload]), [['admin_tools.settings', { version: 1, sections: ['cases'] }]]);
});

test('shared validators: reasons, emoji, embeds and message bodies', () => {
  assert.equal(reason('  no-show  '), 'no-show');
  assert.throws(() => reason('   '), OpsInputError);
  assert.throws(() => reason('x'.repeat(501)), OpsInputError);
  assert.equal(emojiOrNull('🎫', 'Emoji'), '🎫');
  assert.equal(emojiOrNull('123456789012345678', 'Emoji'), '123456789012345678');
  assert.equal(emojiOrNull(null, 'Emoji'), null);
  assert.throws(() => emojiOrNull('ticket', 'Emoji'), OpsInputError);
  const card = { title: 'Rules', description: null, color: 0xff0000, url: null, imageUrl: null, thumbnailUrl: null, footer: null,
    fields: [{ name: 'One', value: 'Be kind', inline: false }] };
  assert.deepEqual(embed(card), card);
  assert.throws(() => embed({ ...card, url: 'http://insecure' }), /https/);
  assert.throws(() => embed({ ...card, title: null, fields: [] }), /needs a title/);
  assert.deepEqual(messageBody({ content: ' hi ', embed: null }), { content: 'hi', embed: null });
  assert.throws(() => messageBody({ content: '   ', embed: null }), /needs text or an embed/);
});

test('memory counters are per guild and per name', () => {
  const counters = new MemoryAdminCounters();
  assert.deepEqual([counters.next(guild, 'case'), counters.next(guild, 'case'), counters.next(guild, 'ticket'), counters.next(channel, 'case')],
    [1, 2, 1, 1]);
});
