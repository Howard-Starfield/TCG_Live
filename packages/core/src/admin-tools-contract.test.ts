import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from './admin-contract.js';
import { ADMIN_TOOLS_AUDIT_KINDS, ADMIN_TOOLS_LIMITS as L, DEFAULT_ADMIN_TOOLS_SETTINGS, privilegedIntentsForSettings,
  renderWelcomeMessage, type AdminToolsSettingsBodyDto } from './admin-tools-contract.js';
import { OPS_AUDIT_KINDS } from './moderation-contract.js';

test('admin tools capabilities extend the existing capability list', () => {
  for (const capability of ['members.read', 'members.moderate', 'server.manage'] as const) assert.ok(CAPABILITIES.includes(capability));
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length);
});

test('admin tools audit kinds are ops-audit kinds and fit the database check', () => {
  for (const kind of ADMIN_TOOLS_AUDIT_KINDS) {
    assert.ok((OPS_AUDIT_KINDS as readonly string[]).includes(kind), kind);
    assert.match(kind, /^[a-z][a-z_.]{2,63}$/);
  }
  assert.equal(new Set(OPS_AUDIT_KINDS).size, OPS_AUDIT_KINDS.length);
});

test('privileged intents follow the decisions: opt-in per feature', () => {
  const settings = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  assert.deepEqual(privilegedIntentsForSettings(settings), { guildMembers: false, messageContent: false });
  for (const key of ['joinLeave', 'welcome', 'autoRole'] as const) {
    const next = structuredClone(settings);
    next.logging[key].enabled = true;
    assert.deepEqual(privilegedIntentsForSettings(next), { guildMembers: true, messageContent: false }, key);
  }
  settings.logging.messageLog.enabled = true;
  assert.deepEqual(privilegedIntentsForSettings(settings), { guildMembers: false, messageContent: true });
});

test('defaults sit inside the limits and the welcome template renders', () => {
  const d = DEFAULT_ADMIN_TOOLS_SETTINGS;
  assert.equal(d.tickets.maxOpenPerUser, 1);
  assert.equal(d.logging.messageLog.enabled, false, 'message log is off by default');
  assert.ok(d.logging.messageLog.retentionDays >= L.retentionDaysMin && d.logging.messageLog.retentionDays <= L.retentionDaysMax);
  assert.ok(d.logging.welcome.message.length <= L.welcomeMessageLength);
  assert.ok(d.tickets.namingPattern.length <= L.ticketNamingPatternLength);
  assert.equal(renderWelcomeMessage('Hi {user} to {server} #{memberCount} {other}', { user: '<@1>', server: 'TCG', memberCount: 5 }),
    'Hi <@1> to TCG #5 {other}');
});
