import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPrivateDiscordConfig } from '../discord/config.js';
import { MatchRoomReconciler, type RoomTransport } from '../discord/match-rooms.js';
import { createSignupFixture } from '../rehearsal/domain.js';
import type { SessionRow } from '../discord/session.js';
import { VoicePoolIdentities } from './identities.js';
import { voiceDependencyReport } from './connection.js';

const ids = Array.from({ length: 12 }, (_, index) => `${index + 10}`.repeat(9));
const eventId = '11111111-1111-4111-8111-111111111111';
const config = readPrivateDiscordConfig({ TCG_DISCORD_APPLICATION_ID: ids[0], TCG_DISCORD_GUILD_ID: ids[1],
  TCG_DISCORD_CHANNEL_ID: ids[2], TCG_DISCORD_M1_CHANNEL_ID: ids[3], TCG_DISCORD_M2_CHANNEL_ID: ids[4],
  TCG_DISCORD_ADMIN_ID: ids[5], TCG_DISCORD_PUBLIC_MATCH_ROOMS: '1' }, false, 'signup');
const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId, channel_id: config.channelId,
  identity_map: { kind: 'signup', adminId: config.adminId, matchChannels: config.matchChannels, publicMatchRooms: true }, status: 'active',
  checkin_message_id: null, m1_message_id: null, m2_message_id: null };

test('match-room placement ignores voice-state changes from the main bot and every helper bot', async () => {
  const pool = new VoicePoolIdentities();
  const mainBot = ids[6]!;
  const helper = ids[8]!;
  pool.set('main', mainBot);
  pool.set('helper-1', helper);
  let reads = 0;
  const transport: RoomTransport = { async current() { return []; }, async assertPermissions() {}, async replace() {},
    voiceChannel: () => null, async move() {}, async warnOrganizer() {} };
  const reconciler = new MatchRoomReconciler(config, mainBot, null, transport,
    async () => { reads += 1; return { session, state: createSignupFixture(eventId) }; }, () => true, Date.now, async () => {}, pool);
  await reconciler.trigger(false, mainBot);
  await reconciler.trigger(false, helper);
  assert.equal(reads, 0, 'pool bots never start a placement pass');
  await reconciler.trigger(false, ids[9]!);
  assert.ok(reads > 0, 'a real member still does');
  pool.set('helper-1', null);
  const before = reads;
  await reconciler.trigger(false, helper);
  assert.ok(reads > before, 'a removed helper is an ordinary member again');
  await reconciler.stop();
});

test('voice dependencies need no native build: opusscript, built-in aes-256-gcm and prebuilt DAVE', async () => {
  const report = await voiceDependencyReport();
  assert.match(report, /opusscript: \d/);
  assert.match(report, /@discordjs\/opus: not found/);
  assert.match(report, /sodium-native: not found/);
  assert.match(report, /aes-256-gcm: yes/);
  assert.match(report, /@snazzah\/davey: \d/);
});

test('opusscript decodes an Opus silence frame to 20 ms of 48 kHz stereo PCM', async () => {
  const { opusscriptDecoderFactory } = await import('./connection.js');
  const { OPUS_SILENCE_FRAME } = await import('./ogg-writer.js');
  const decoder = opusscriptDecoderFactory()();
  try { assert.equal(decoder.decode(Buffer.from(OPUS_SILENCE_FRAME)).length, 960 * 2); }
  finally { decoder.delete(); }
});
