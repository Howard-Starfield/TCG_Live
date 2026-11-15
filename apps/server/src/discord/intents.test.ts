import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { GatewayIntentBits } from 'discord.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto } from '@tcg-live/core';
import { adminToolsCoreFeature } from '../admin-tools/discord-feature.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import type { DiscordFeature } from './features.js';
import { DISALLOWED_INTENTS_CLOSE_CODE, loginWithIntentFallback, planIntents, type IntentGateway } from './intents.js';
import { baseIntents } from './sdk.js';

const defaults = () => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
const withLogs = (members: boolean, messages: boolean) => {
  const settings = defaults();
  settings.logging.joinLeave.enabled = members;
  settings.logging.messageLog.enabled = messages;
  return settings;
};

test('privileged intents are requested only while the settings need them', () => {
  const features = [adminToolsCoreFeature(), { name: 'voice', intents: [GatewayIntentBits.GuildVoiceStates], start() {}, stop() {} }];
  const off = planIntents(baseIntents(), features, defaults());
  assert.deepEqual(off.privileged, []);
  assert.ok(off.intents.includes(GatewayIntentBits.GuildVoiceStates));
  assert.ok(!off.intents.includes(GatewayIntentBits.GuildMembers));
  const on = planIntents(baseIntents(), features, withLogs(true, true));
  assert.deepEqual(on.privileged, ['guildMembers', 'messageContent']);
  const presences: DiscordFeature = { name: 'x', intentsFor: () => [GatewayIntentBits.GuildPresences], start() {}, stop() {} };
  assert.ok(!planIntents(baseIntents(), [presences], defaults()).intents.includes(GatewayIntentBits.GuildPresences), 'presences is never requested');
  const broken: DiscordFeature = { name: 'y', intentsFor: () => { throw Error('bad'); }, start() {}, stop() {} };
  assert.deepEqual(planIntents(baseIntents(), [broken], defaults()).intents, baseIntents());
});

class FakeGateway extends EventEmitter implements IntentGateway {
  destroyed = false;
  constructor(readonly intents: GatewayIntentBits[]) { super(); }
  destroy() { this.destroyed = true; }
}

test('a Disallowed intents refusal retries once without the privileged intents and reports them missing', async () => {
  const created: FakeGateway[] = [];
  const logs: string[] = [];
  const plan = planIntents(baseIntents(), [adminToolsCoreFeature()], withLogs(true, false));
  const result = await loginWithIntentFallback({ plan, log: message => logs.push(message),
    create: intents => { const client = new FakeGateway(intents); created.push(client); return client; },
    login: async (client, refused) => {
      if (client.intents.includes(GatewayIntentBits.GuildMembers)) {
        client.emit('shardDisconnect', { code: DISALLOWED_INTENTS_CLOSE_CODE }, 0);
        assert.equal(refused(), true);
        throw new Error('Private Discord Gateway readiness was interrupted or timed out.');
      }
    } });
  assert.equal(created.length, 2);
  assert.equal(created[0]!.destroyed, true);
  assert.equal(result.client, created[1]);
  assert.ok(!created[1]!.intents.includes(GatewayIntentBits.GuildMembers));
  assert.deepEqual(result.missing, ['guildMembers']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /Developer Portal/);
  assert.equal(created[1]!.listenerCount('shardDisconnect'), 0, 'listeners are removed');
});

test('other login failures, and refusals without privileged intents, are rethrown unchanged', async () => {
  const plan = planIntents(baseIntents(), [adminToolsCoreFeature()], withLogs(true, false));
  await assert.rejects(loginWithIntentFallback({ plan, log: () => {}, create: intents => new FakeGateway(intents),
    login: async () => { throw new Error('An invalid token was provided.'); } }), /invalid token/);
  const plain = planIntents(baseIntents(), [], defaults());
  await assert.rejects(loginWithIntentFallback({ plan: plain, log: () => {}, create: intents => new FakeGateway(intents),
    login: async () => { throw new Error('Used disallowed intents'); } }), /disallowed/);
  const ok = await loginWithIntentFallback({ plan, log: () => {}, create: intents => new FakeGateway(intents), login: async () => {} });
  assert.deepEqual(ok.missing, []);
});

test('status: on, missing, and restart required when the saved settings change the intent set', () => {
  const state = new AdminToolsRuntimeState([adminToolsCoreFeature()], 'discord');
  assert.equal(state.describe(defaults()).runtime, 'offline');
  state.recordLogin({ requested: ['guildMembers'], missing: ['guildMembers'] });
  state.recordFeatures({ started: ['admin-tools'], failed: [] });
  const missing = state.describe(withLogs(true, false));
  assert.deepEqual(missing.privilegedIntents, { guildMembers: 'missing', messageContent: 'off' });
  assert.equal(missing.restartRequired, true);
  assert.match(missing.restartReason!, /Server Members Intent.*Developer Portal/);
  assert.deepEqual(missing.features, [{ name: 'admin-tools', state: 'intent-missing', missingIntents: ['guildMembers'] }]);

  state.recordLogin({ requested: ['guildMembers'], missing: [] });
  const steady = state.describe(withLogs(true, false));
  assert.equal(steady.restartRequired, false);
  assert.equal(steady.features[0]!.state, 'running');
  const added = state.describe(withLogs(true, true));
  assert.equal(added.restartRequired, true);
  assert.match(added.restartReason!, /Message Content Intent/);
  const dropped = state.describe(defaults());
  assert.equal(dropped.restartRequired, true);
  assert.match(dropped.restartReason!, /no longer needed/);
  state.recordFeatures({ started: [], failed: ['admin-tools'] });
  assert.equal(state.describe(withLogs(true, false)).features[0]!.state, 'failed');
});
