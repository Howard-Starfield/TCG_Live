import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Collection, Events, MessageFlags, MessageType, type Guild, type GuildMember,
  type Interaction, type TextChannel, type VoiceChannel } from 'discord.js';
import { channelForSlot, readPrivateDiscordConfig, publicConfig } from './config.js';
import { assertSessionConfig, type SessionRow } from './session.js';
import { adapt, discordRoomTransport, discordTransport, loginAndWaitReady } from './runtime.js';

const settings: NodeJS.ProcessEnv = {
  TCG_DISCORD_APPLICATION_ID: '111111111111111111',
  TCG_DISCORD_GUILD_ID: '222222222222222222',
  TCG_DISCORD_CHANNEL_ID: '333333333333333333',
  TCG_DISCORD_PLAYER_A_ID: '444444444444444444',
  TCG_DISCORD_PLAYER_B_ID: '555555555555555555',
  TCG_DISCORD_PLAYER_C_ID: '666666666666666666',
  TCG_DISCORD_PLAYER_D_ID: '777777777777777777',
  TCG_DISCORD_ADMIN_ID: '888888888888888888'
};

test('private config accepts DISCORD_BOT_TOKEN fallback without persisting or printing it', () => {
  const fallback = readPrivateDiscordConfig({ ...settings, DISCORD_BOT_TOKEN: 'synthetic-fallback' }, true);
  assert.equal(fallback.token, 'synthetic-fallback');
  assert.equal('token' in publicConfig(fallback), false);
  const preferred = readPrivateDiscordConfig({ ...settings, DISCORD_BOT_TOKEN: 'synthetic-fallback',
    TCG_DISCORD_TOKEN: 'synthetic-primary' }, true);
  assert.equal(preferred.token, 'synthetic-primary');
  const whitespacePrimary = readPrivateDiscordConfig({ ...settings, DISCORD_BOT_TOKEN: 'synthetic-fallback',
    TCG_DISCORD_TOKEN: '  ' }, true);
  assert.equal(whitespacePrimary.token, 'synthetic-fallback');
  assert.throws(() => readPrivateDiscordConfig(settings, true), /TCG_DISCORD_TOKEN or DISCORD_BOT_TOKEN/);
});

test('runtime can be imported without executing its CLI', async () => {
  const runtime = await import('./runtime.js');
  assert.equal(typeof runtime.discordTransport, 'function');
  assert.equal(typeof runtime.adapt, 'function');
  assert.equal(runtime.commandDefinition().name, 'tcg-test');
});

test('match channels are paired, validated, and frozen against saved session routing', () => {
  const legacy = readPrivateDiscordConfig(settings);
  assert.equal(channelForSlot(legacy, 'M1'), legacy.channelId);
  assert.throws(() => readPrivateDiscordConfig({ ...settings,
    TCG_DISCORD_M1_CHANNEL_ID: '999999999999999999' }), /Both private Discord match channels/);
  assert.throws(() => readPrivateDiscordConfig({ ...settings,
    TCG_DISCORD_M1_CHANNEL_ID: 'bad', TCG_DISCORD_M2_CHANNEL_ID: '101010101010101010' }), /M1_CHANNEL_ID/);
  const routed = readPrivateDiscordConfig({ ...settings,
    TCG_DISCORD_M1_CHANNEL_ID: '999999999999999999',
    TCG_DISCORD_M2_CHANNEL_ID: '101010101010101010' });
  assert.equal(channelForSlot(routed, 'checkin'), routed.channelId);
  assert.equal(channelForSlot(routed, 'M2'), '101010101010101010');
  const session: SessionRow = { event_id: 'fixture', application_id: legacy.applicationId,
    guild_id: legacy.guildId, channel_id: legacy.channelId,
    identity_map: { players: legacy.players, adminId: legacy.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  assert.doesNotThrow(() => assertSessionConfig(session, legacy), 'legacy mapping defaults to control channel');
  assert.throws(() => assertSessionConfig(session, routed), /configuration differs/);
  session.identity_map.matchChannels = routed.matchChannels;
  assert.doesNotThrow(() => assertSessionConfig(session, routed));
  assert.throws(() => assertSessionConfig(session, legacy), /configuration differs/);
});

test('production card transport selects the control or assigned match message manager', async () => {
  const calls: string[] = [];
  const channel = (name: string) => ({
    async send() { calls.push(`send:${name}`); return { id: '111111111111111111' }; },
    messages: { async fetch(query: unknown) { calls.push(`fetch:${name}`); if (typeof query === 'object') return new Map(); return {
      async edit() { calls.push(`edit:${name}`); },
      async pin() { calls.push(`pin:${name}`); }
    }; } }
  });
  const transport = discordTransport(channel('control') as unknown as TextChannel, {
    M1: channel('M1') as unknown as VoiceChannel,
    M2: channel('M2') as unknown as VoiceChannel
  });
  const card = { embeds: [], components: [], allowedMentions: { parse: [] as [] } };
  await transport.send(card, 'checkin');
  await transport.send(card, 'M1');
  await transport.send(card, 'M2');
  await transport.edit('111111111111111111', card, 'M1');
  await transport.pin('111111111111111111', 'checkin');
  assert.deepEqual(calls, ['send:control', 'send:M1', 'send:M2', 'fetch:M1', 'edit:M1',
    'fetch:control', 'fetch:control', 'pin:control']);
});

test('pin notice cleanup deletes only a new bot-authored notice for that exact card', async () => {
  const deleted: string[] = [];
  const notices = new Map<string, object>();
  const channel = { messages: { async fetch(query: unknown) {
    if (typeof query === 'object') return new Collection(notices);
    return { async pin() {
      notices.set('notice-own', { id: 'notice-own', type: MessageType.ChannelPinnedMessage,
        author: { id: 'bot' }, reference: { messageId: 'card' },
        async delete() { deleted.push('notice-own'); } });
      notices.set('notice-other', { id: 'notice-other', type: MessageType.ChannelPinnedMessage,
        author: { id: 'other-bot' }, reference: { messageId: 'card' },
        async delete() { deleted.push('notice-other'); } });
    } };
  } } };
  await discordTransport(channel as unknown as TextChannel, undefined, 'bot').pin('card', 'checkin');
  assert.deepEqual(deleted, ['notice-own']);
});

test('resume reminder uses exact waiting-user mention permission in the assigned match channel', async () => {
  const sends: Array<{ channel: string; content: string; allowedMentions: { parse: []; users: string[] };
    embeds: Array<{ description: string; thumbnail: { url: string } }>;
    files: Array<{ name: string; attachment: string }> }> = [];
  const channel = (name: string) => ({ async send(options: { content: string;
    allowedMentions: { parse: []; users: string[] }; embeds: Array<{ description: string; thumbnail: { url: string } }>;
    files: Array<{ name: string; attachment: string }> }) {
    sends.push({ channel: name, ...options }); return { id: '111111111111111111' };
  } });
  const transport = discordTransport(channel('control') as unknown as TextChannel,
    { M1: channel('M1') as unknown as VoiceChannel, M2: channel('M2') as unknown as VoiceChannel });
  await transport.resumeReminder!('M1', ['444444444444444444', '444444444444444444']);
  assert.equal(sends[0]?.channel, 'M1');
  assert.equal(sends[0]?.content, 'Waiting to resume: <@444444444444444444>');
  assert.deepEqual(sends[0]?.allowedMentions, { parse: [], users: ['444444444444444444'] });
  assert.match(sends[0]!.embeds[0]!.description, /Both players.*Resume/);
  assert.equal(sends[0]?.embeds[0]?.thumbnail.url, 'attachment://tcg-reminder-v1.gif');
  assert.equal(sends[0]?.files[0]?.name, 'tcg-reminder-v1.gif');
});

test('button ACK updates its panel silently on success and deletes only a private error follow-up', async () => {
  const calls: string[] = [];
  let expiry: (() => void) | undefined;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    assert.equal(ms, 8_000);
    expiry = callback;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const interaction = {
      isButton: () => true, isChatInputCommand: () => false,
      id: 'interaction', applicationId: 'application', guildId: 'guild', channelId: 'channel',
      user: { id: 'user' }, customId: 'control', message: { id: 'shared-panel' },
      async deferUpdate() { calls.push('deferUpdate'); },
      async deferReply() { throw new Error('button must not defer a reply'); },
      async followUp(options: { embeds: Array<{ description: string; thumbnail: { url: string } }>;
        files: Array<{ name: string }>; flags: number }) {
        calls.push(`followUp:${options.embeds[0]?.description}:${options.flags}`);
        assert.equal(options.embeds[0]?.thumbnail.url, 'attachment://tcg-error-v1.png');
        assert.equal(options.files[0]?.name, 'tcg-error-v1.png');
        return { id: 'private-followup' };
      },
      async deleteReply() { throw new Error('shared panel must not be deleted'); },
      webhook: { async deleteMessage(id: string) { calls.push(`delete:${id}`); } }
    };
    const adapted = adapt(interaction as unknown as Interaction)!;
    await adapted.acknowledge();
    await adapted.reply('Saved: pause.');
    await adapted.reply('No change: checkin.');
    assert.deepEqual(calls, ['deferUpdate']);
    await adapted.reply('This control is stale.');
    assert.deepEqual(calls, ['deferUpdate', `followUp:This control is stale.:${MessageFlags.Ephemeral}`]);
    expiry!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1), 'delete:private-followup');
  } finally { globalThis.setTimeout = original; }
});

test('slash command keeps a private acknowledgment and expires only its original reply', async () => {
  const calls: string[] = [];
  let expiry: (() => void) | undefined;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    assert.equal(ms, 8_000);
    expiry = callback;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const command = {
      isButton: () => false, isChatInputCommand: () => true, commandName: 'tcg-test',
      id: 'interaction', applicationId: 'application', guildId: 'guild', channelId: 'channel',
      user: { id: 'admin' }, options: { getSubcommand: () => 'refresh', getString: () => null },
      async deferReply(options: { flags: number }) { calls.push(`defer:${options.flags}`); },
      async editReply(options: { embeds: Array<{ description: string; thumbnail: { url: string } }>;
        files: Array<{ name: string }> }) {
        calls.push(`edit:${options.embeds[0]?.description}`);
        assert.equal(options.embeds[0]?.thumbnail.url, 'attachment://tcg-final-v1.gif');
        assert.equal(options.files[0]?.name, 'tcg-final-v1.gif');
      },
      async deleteReply(id: string) { calls.push(`delete:${id}`); }
    };
    const adapted = adapt(command as unknown as Interaction)!;
    await adapted.acknowledge();
    await adapted.reply('Practice cards refreshed.');
    expiry!();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [`defer:${MessageFlags.Ephemeral}`, 'edit:Practice cards refreshed.',
      'delete:@original']);
  } finally { globalThis.setTimeout = original; }
});

test('slow private visual upload starts after button ACK and deletes only its follow-up', async () => {
  const calls: string[] = [];
  let release!: () => void;
  let expire!: () => void;
  const upload = new Promise<void>(resolve => { release = resolve; });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    assert.equal(ms, 8_000);
    expire = callback;
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    const interaction = { isButton: () => true, isChatInputCommand: () => false,
      id: 'interaction', applicationId: 'application', guildId: 'guild', channelId: 'channel',
      user: { id: 'user' }, customId: 'control', message: { id: 'shared-panel' },
      async deferUpdate() { calls.push('ack'); },
      async followUp(options: { embeds: Array<{ description: string }> }) {
        calls.push(`upload:${options.embeds[0]?.description}`);
        await upload;
        return { id: 'private-followup' };
      },
      webhook: { async deleteMessage(id: string) { calls.push(`delete:${id}`); } }
    };
    const adapted = adapt(interaction as unknown as Interaction)!;
    await adapted.acknowledge();
    const pending = adapted.reply('This control is stale.');
    assert.deepEqual(calls, ['ack', 'upload:This control is stale.']);
    release();
    await pending;
    expire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1), 'delete:private-followup');
    assert.equal(calls.includes('delete:shared-panel'), false);
  } finally { globalThis.setTimeout = original; }
});

test('organizer warning keeps its admin-only ping and uses one local visual', async () => {
  const sends: unknown[] = [];
  const control = { async send(options: unknown) { sends.push(options); } };
  const transport = discordRoomTransport({} as Guild, {} as Record<'M1' | 'M2', VoiceChannel>,
    {} as GuildMember, control as unknown as TextChannel, settings.TCG_DISCORD_ADMIN_ID!);
  await transport.warnOrganizer('Automatic placement paused.');
  const sent = sends[0] as { content: string; allowedMentions: { parse: []; users: string[] };
    embeds: Array<{ description: string; thumbnail: { url: string } }>;
    files: Array<{ name: string }> };
  assert.equal(sent.content, `<@${settings.TCG_DISCORD_ADMIN_ID}>`);
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [settings.TCG_DISCORD_ADMIN_ID] });
  assert.equal(sent.embeds[0]?.description, 'Automatic placement paused.');
  assert.equal(sent.embeds[0]?.thumbnail.url, 'attachment://tcg-notice-v1.gif');
  assert.deepEqual(sent.files.map(file => file.name), ['tcg-notice-v1.gif']);
});

class FakeGateway extends EventEmitter {
  ready = false;
  loginAction: () => Promise<string> = async () => 'synthetic-token';

  login(): Promise<string> { return this.loginAction(); }
  isReady(): boolean { return this.ready; }
}

test('gateway readiness is awaited after login resolves and listener is installed first', async () => {
  const gateway = new FakeGateway();
  gateway.loginAction = async () => {
    assert.equal(gateway.listenerCount(Events.ClientReady), 1);
    setTimeout(() => {
      gateway.ready = true;
      gateway.emit(Events.ClientReady);
    }, 10);
    return 'synthetic-token';
  };
  await loginAndWaitReady(gateway, 'synthetic-token', undefined, 100);
  assert.equal(gateway.listenerCount(Events.ClientReady), 0);
});

test('gateway readiness waiter cleans up after login failure, cancellation, and timeout', async () => {
  const failed = new FakeGateway();
  failed.loginAction = async () => { throw new Error('synthetic login failure'); };
  await assert.rejects(loginAndWaitReady(failed, 'synthetic-token', undefined, 100), /synthetic login failure/);
  assert.equal(failed.listenerCount(Events.ClientReady), 0);

  const cancelled = new FakeGateway();
  let stop = false;
  cancelled.loginAction = async () => {
    setTimeout(() => { stop = true; }, 5);
    return 'synthetic-token';
  };
  await assert.rejects(loginAndWaitReady(cancelled, 'synthetic-token', () => stop, 500), /readiness/);
  assert.equal(cancelled.listenerCount(Events.ClientReady), 0);

  const timedOut = new FakeGateway();
  await assert.rejects(loginAndWaitReady(timedOut, 'synthetic-token', undefined, 5), /readiness/);
  assert.equal(timedOut.listenerCount(Events.ClientReady), 0);
});
