import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CAPABILITIES } from '@tcg-live/core';
import { readAdminConfig, useGuidedSettings } from '../admin/config.js';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { SetupProfileStore } from './profile.js';
import { LocalSettings } from './settings.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444', '555555555555555555'];
const selection = { guildId: ids[0]!, channelId: ids[1]!, matchChannels: { M1: ids[2]!, M2: ids[3]! },
  adminId: ids[4]!, publicMatchRooms: true };

async function withProfile<T>(run: (store: SetupProfileStore, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tcg-local-settings-'));
  try { return await run(new SetupProfileStore(path.join(directory, 'discord-setup.json')), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('profile migration: a missing settings field means dashboard actions on, voice off; setup saves keep the switches', async () => {
  await withProfile(async store => {
    assert.deepEqual((await store.read()).settings, undefined, 'no file: setup has not saved anything yet');
    // A profile written before this wave has no settings key.
    await writeFile(store.file, JSON.stringify({ version: 1, selection, guide: null, completed: true }));
    assert.deepEqual((await store.read()).settings, { dashboardActions: true, voiceMonitoring: false });
    await writeFile(store.file, JSON.stringify({ version: 1, selection, guide: null, completed: true, settings: { voiceMonitoring: true } }));
    assert.deepEqual((await store.read()).settings, { dashboardActions: true, voiceMonitoring: true });
    await store.updateSwitches(current => ({ ...current, dashboardActions: false }));
    // The setup service saves without settings: the switches on disk survive.
    await store.save({ selection, guide: null, completed: false });
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    assert.deepEqual(saved.settings, { dashboardActions: false, voiceMonitoring: true });
    assert.equal(saved.completed, false);
    await writeFile(store.file, JSON.stringify({ version: 1, selection, guide: null, completed: true, settings: { dashboardActions: 'yes' } }));
    await assert.rejects(store.read(), /Setup profile is invalid/);
  });
});

test('env precedence matrix: 1 forces on; 0, blank and unset defer to the switch', async () => {
  await withProfile(async store => {
    for (const saved of [true, false]) {
      await store.updateSwitches(() => ({ dashboardActions: saved, voiceMonitoring: saved }));
      for (const [raw, forced] of [[undefined, false], ['', false], ['0', false], [' 1 ', true], ['1', true]] as const) {
        const env: NodeJS.ProcessEnv = raw === undefined ? {} : { TCG_ADMIN_COMMANDS: raw, TCG_DISCORD_VOICE: raw };
        const local = await LocalSettings.load({ store, env });
        const expected = forced || saved;
        assert.equal(local.dashboardActionsEnabled(), expected, `actions saved=${saved} env=${raw}`);
        assert.equal(local.applyVoice(env), expected, `voice saved=${saved} env=${raw}`);
        assert.equal(env.TCG_DISCORD_VOICE?.trim(), expected ? '1' : '0', 'the voice feature reads the effective value');
        assert.equal(local.describe().dashboardActions.forcedByEnv, forced);
      }
    }
    // An invalid voice value is left for the voice feature to report; it stays off.
    const env: NodeJS.ProcessEnv = { TCG_DISCORD_VOICE: 'yes' };
    assert.equal((await LocalSettings.load({ store, env })).applyVoice(env), false);
    assert.equal(env.TCG_DISCORD_VOICE, 'yes');
  });
});

test('readAdminConfig follows the guided switch live; direct runs keep the .env flag', async () => {
  await withProfile(async store => {
    const local = await LocalSettings.load({ store, env: {} });
    assert.equal(readAdminConfig('discord', {}).commandsEnabled, false);
    useGuidedSettings(local);
    try {
      const config = readAdminConfig('discord', { TCG_ADMIN_CONSOLE: '1', TCG_ADMIN_COMMANDS: '0' });
      assert.equal(config.commandsEnabled, true, 'default on');
      assert.equal(config.localSettings, local);
      await local.update({ dashboardActions: false });
      assert.equal(config.commandsEnabled, false, 'the same config object sees the change');
      assert.equal(readAdminConfig('discord', { TCG_ADMIN_COMMANDS: '1' }).commandsEnabled, true, 'env 1 wins');
      assert.equal(readAdminConfig('demo', {}).commandsEnabled, true);
      assert.throws(() => readAdminConfig('discord', { TCG_ADMIN_COMMANDS: 'yes' }), /TCG_ADMIN_COMMANDS must be 0 or 1/);
    } finally { useGuidedSettings(null); }
    assert.equal(readAdminConfig('discord', {}).commandsEnabled, false);
  });
});

test('capabilities are granted per request: switching off and on applies to a signed-in session without a new sign-in', async () => {
  await withProfile(async (store, directory) => {
    const local = await LocalSettings.load({ store, env: {}, auditFile: path.join(directory, 'audit.jsonl'), now: () => 1234 });
    const audit = new MemoryOpsAuditStore();
    local.attachAudit(audit);
    const harness = await startHarness({ mode: 'discord', commandsEnabled: false, localSettings: local,
      commandsLive: () => local.dashboardActionsEnabled() });
    try {
      const token = await login(harness);
      const session = async () => (await call(harness.port, '/api/v1/session', { token })).json();
      assert.equal((await session()).commandsEnabled, true);
      assert.deepEqual((await session()).capabilities, [...CAPABILITIES]);
      assert.equal((await session()).localSettings, true);
      const put = (body: unknown) => call(harness.port, '/api/v1/settings/local', { method: 'PUT', token, body: JSON.stringify(body) });
      const off = await put({ dashboardActions: false });
      assert.equal(off.status, 200);
      assert.deepEqual(off.json().dashboardActions, { enabled: false, saved: false, forcedByEnv: false });
      assert.deepEqual((await session()).capabilities, ['dashboard.read']);
      const refresh = await call(harness.port, '/api/v1/panels/refresh', { method: 'POST', token,
        body: JSON.stringify({ eventId: 'event' }) });
      assert.equal(refresh.status, 403);
      assert.equal((await put({ dashboardActions: true })).json().dashboardActions.enabled, true);
      assert.equal((await session()).commandsEnabled, true);
      // Strict body, Origin check and sign-in still apply.
      assert.equal((await put({ dashboardActions: 'on' })).status, 400);
      assert.equal((await put({})).status, 400);
      assert.equal((await put({ dashboardActions: true, other: 1 })).status, 400);
      assert.equal((await call(harness.port, '/api/v1/settings/local', { method: 'PUT', body: '{"dashboardActions":true}' })).status, 401);
      assert.equal((await call(harness.port, '/api/v1/settings/local', { method: 'PUT', token, origin: false,
        body: '{"dashboardActions":true}' })).status, 403);
      // Audited in both sinks, without secrets.
      const page = await audit.list();
      assert.deepEqual(page.entries.map(entry => entry.kind), ['local.settings', 'local.settings']);
      assert.deepEqual(page.entries[0]!.payload.changes, { dashboardActions: { from: true, to: false } });
      const lines = (await readFile(path.join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(lines[1].occurredAtMs, 1234);
      assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).settings, { dashboardActions: true, voiceMonitoring: false });
    } finally { await harness.stop(); }
  });
});

test('voice switch is saved now and reports a restart until the bot picks it up', async () => {
  await withProfile(async store => {
    const local = await LocalSettings.load({ store, env: {} });
    assert.equal(local.describe().voiceMonitoring.restartRequired, false, 'not started yet');
    await local.update({ voiceMonitoring: true });
    assert.deepEqual(local.describe().voiceMonitoring, { saved: true, running: null, forcedByEnv: false, restartRequired: false });
    const env: NodeJS.ProcessEnv = {};
    local.applyVoice(env);
    assert.equal(env.TCG_DISCORD_VOICE, '1');
    await local.update({ voiceMonitoring: false });
    assert.deepEqual(local.describe().voiceMonitoring, { saved: false, running: true, forcedByEnv: false, restartRequired: true });
    const forced = await LocalSettings.load({ store, env: { TCG_DISCORD_VOICE: '1' } });
    forced.applyVoice({ TCG_DISCORD_VOICE: '1' });
    assert.equal(forced.describe().voiceMonitoring.restartRequired, false);
  });
});
