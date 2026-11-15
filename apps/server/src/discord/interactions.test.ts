import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Interaction } from 'discord.js';
import { adminToolsCoreFeature } from '../admin-tools/discord-feature.js';
import { ADMIN_COMMAND_NAME, adminCommandDefinition, adminSubcommands } from './admin-command.js';
import type { DiscordFeatureContext } from './features.js';
import { assertPrefixRegistry, FEATURE_INTERACTION_PREFIXES, FeatureInteractionRouter, isFeatureInteractionId } from './interactions.js';
import { adapt, commandDefinition } from './runtime.js';

const scope = { applicationId: '111111111111111111', guildId: '222222222222222222' };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fake(kind: 'button' | 'modal' | 'command', extra: Record<string, unknown> = {}) {
  const replies: string[] = [];
  return { replies, interaction: {
    id: 'i', applicationId: scope.applicationId, guildId: scope.guildId, channelId: '333333333333333333', user: { id: '444444444444444444' },
    message: { id: 'm' }, replied: false, deferred: false,
    isMessageComponent: () => kind === 'button', isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
    isChatInputCommand: () => kind === 'command',
    async reply(options: { content: string }) { replies.push(options.content); },
    async followUp(options: { content: string }) { replies.push(options.content); },
    ...extra
  } };
}

test('the prefix registry is well formed and never overlaps the controller IDs', () => {
  assert.doesNotThrow(() => assertPrefixRegistry());
  assert.throws(() => assertPrefixRegistry(['p1:x:']), /Invalid|overlaps/);
  assert.throws(() => assertPrefixRegistry(['tk:', 'tk:']), /overlaps/);
  assert.throws(() => assertPrefixRegistry(['p1:']), /overlaps/);
  assert.equal(isFeatureInteractionId(`${FEATURE_INTERACTION_PREFIXES.tickets}open`), true);
  assert.equal(isFeatureInteractionId('p1:11111111-1111-4111-8111-111111111111:M1:R'), false);
});

test('feature controls route by prefix; controller buttons still adapt for the controller', async () => {
  const router = new FeatureInteractionRouter(scope);
  const seen: string[] = [];
  const off = router.onComponent('tk:', async interaction => { seen.push(interaction.customId); });
  assert.throws(() => router.onComponent('tk:', async () => {}), /already/);
  assert.throws(() => router.onComponent('zz:' as 'tk:', async () => {}), /not reserved/);

  const ticket = fake('button', { customId: 'tk:open' });
  assert.equal(router.dispatch(ticket.interaction as never), true);
  await settle();
  assert.deepEqual(seen, ['tk:open']);
  assert.equal(adapt(ticket.interaction as unknown as Interaction), null, 'the controller never answers feature IDs');

  // Registered prefix without a live handler: claimed (controller must not answer) and told politely.
  off();
  const orphan = fake('button', { customId: 'tk:open' });
  assert.equal(router.dispatch(orphan.interaction as never), true);
  await settle();
  assert.match(orphan.replies[0]!, /not available/);

  const card = fake('button', { customId: 'p1:11111111-1111-4111-8111-111111111111:M1:R', async deferUpdate() {} });
  assert.equal(router.dispatch(card.interaction as never), false);
  const adapted = adapt(card.interaction as unknown as Interaction);
  assert.equal(adapted?.kind, 'button');
  assert.equal(adapted?.customId, 'p1:11111111-1111-4111-8111-111111111111:M1:R');

  // Other guilds and applications are ignored.
  const foreign = fake('button', { customId: 'tk:open', guildId: '999999999999999999' });
  assert.equal(router.dispatch(foreign.interaction as never), false);
});

test('modals and /tcg-admin subcommands route; handler failures answer with a notice', async () => {
  const router = new FeatureInteractionRouter(scope, () => {});
  const seen: string[] = [];
  router.onModal('br:', async interaction => { seen.push(`modal:${interaction.customId}`); });
  router.onSubcommand('status', async () => { throw new Error('boom'); });
  assert.throws(() => router.onSubcommand('undeclared', async () => {}), /not declared/);
  const modal = fake('modal', { customId: 'br:edit' });
  assert.equal(router.dispatch(modal.interaction as never), true);
  const command = fake('command', { commandName: ADMIN_COMMAND_NAME, options: { getSubcommand: () => 'status' } });
  assert.equal(router.dispatch(command.interaction as never), true);
  const practice = fake('command', { commandName: 'tcg-test', options: { getSubcommand: () => 'refresh' } });
  assert.equal(router.dispatch(practice.interaction as never), false, '/tcg-test stays with the controller');
  await settle(); await settle();
  assert.deepEqual(seen, ['modal:br:edit']);
  assert.match(command.replies[0]!, /did not work/);
});

test('/tcg-admin is staff-only, separate from /tcg-test, and built from the subcommand registry', () => {
  const definition = adminCommandDefinition();
  assert.equal(definition.name, ADMIN_COMMAND_NAME);
  assert.equal(commandDefinition().name, 'tcg-test');
  assert.deepEqual(definition.options?.map(option => option.name), adminSubcommands.map(sub => sub.name));
  assert.equal(definition.default_member_permissions, String(1 << 5), 'Manage Server');
  assert.throws(() => adminCommandDefinition([{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }]), /duplicate/);
});

test('the core feature answers /tcg-admin status and reports refused intents once', async () => {
  const router = new FeatureInteractionRouter(scope);
  const audits: string[] = [];
  const logs: string[] = [];
  const listeners: Array<() => void> = [];
  const status = { runtime: 'running' as const, privilegedIntents: { guildMembers: 'missing' as const, messageContent: 'off' as const },
    wantedIntents: { guildMembers: true, messageContent: false }, restartRequired: true, restartReason: 'Turn it on.', features: [] };
  const ctx = {
    interactions: router, log: (message: string) => logs.push(message), privilegedIntents: () => status.privilegedIntents,
    audit: async (kind: string) => { audits.push(kind); return {}; }, adminToolsStatus: async () => status,
    on: (_type: string, listener: () => void) => { listeners.push(listener); return () => {}; }
  } as unknown as DiscordFeatureContext;
  const feature = adminToolsCoreFeature();
  await feature.start(ctx);
  assert.deepEqual(audits, ['admin_tools.intents_missing']);
  assert.match(logs[0]!, /Server Members Intent/);
  const command = fake('command', { commandName: ADMIN_COMMAND_NAME, options: { getSubcommand: () => 'status' } });
  router.dispatch(command.interaction as never);
  listeners[0]!(); listeners[0]!();
  await settle(); await settle();
  assert.match(command.replies[0]!, /Server Members Intent: missing/);
  assert.equal(logs.filter(line => line.includes('restart required')).length, 1, 'a restart notice is logged once per reason');
  await feature.stop();
});
