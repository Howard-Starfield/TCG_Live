import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS, type MatchId, type ModerationSettingsBodyDto } from '@tcg-live/core';
import type { ModerationFlagInput } from '../moderation/flags.js';
import { HelperBotTransport } from './connection.js';
import { VoicePoolIdentities } from './identities.js';
import { sineFrame } from './loudness.js';
import { DEFAULT_MONITOR_NOTICE, VoiceMonitor, type RecordingHandle, type VoiceRoomInfo } from './monitor.js';
import { planVoiceAssignments, type CoverageRoom, type VoicePoolLiveState } from './pool.js';
import type { RecordingTarget } from './recorder.js';
import { FakeVoiceBot, fakeDecoder, syntheticToken } from './testing.js';
import { tokenUserId, type VoiceBotCredential } from './tokens.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const guildId = '100000000000000001';
const P = { a: '200000000000000001', b: '200000000000000002', c: '200000000000000003', d: '200000000000000004' };
const SPECTATOR = '300000000000000009';
const rooms = (): VoiceRoomInfo[] => [
  { eventId, matchId: 'M1', voiceChannelId: '400000000000000001', playerIds: [P.a, P.b], phase: 'running' },
  { eventId, matchId: 'M2', voiceChannelId: '400000000000000002', playerIds: [P.c, P.d], phase: 'running' }
];
const credential = (id: string, user: string, tail = 'x'): VoiceBotCredential => {
  const token = syntheticToken(user, tail);
  return { id, label: `Helper ${id}`, token, userId: tokenUserId(token), addedAtMs: 1, applicationId: null, enabled: true, nickname: null };
};
const settingsWith = (patch: { recording?: ModerationSettingsBodyDto['recording']; voice?: Partial<ModerationSettingsBodyDto['voice']>;
  noticeText?: string | null }): ModerationSettingsBodyDto =>
  ({ ...DEFAULT_MODERATION_SETTINGS, ...patch, recording: patch.recording ?? DEFAULT_MODERATION_SETTINGS.recording,
    voice: { ...DEFAULT_MODERATION_SETTINGS.voice, ...patch.voice } });

function harness(initial: { settings?: ModerationSettingsBodyDto; helpers?: VoiceBotCredential[]; helperLogin?: (id: string) => 'ready' | 'login failed' } = {}) {
  let now = 1_000_000;
  let noticeFails = false;
  const audits: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  let settings = initial.settings ?? settingsWith({});
  let helpers = initial.helpers ?? [];
  let currentRooms = rooms();
  const main = new FakeVoiceBot('main', '500000000000000000', 'ready', 'ready');
  const made = new Map<string, FakeVoiceBot>();
  const flags: ModerationFlagInput[] = [];
  const published: Array<VoicePoolLiveState | null> = [];
  const notices: Array<{ channelId: string; text: string }> = [];
  const organizer: string[] = [];
  const logs: string[] = [];
  const recordings: Array<{ target: RecordingTarget; handle: RecordingHandle; writes: string[]; stopped: string | null }> = [];
  const identities = new VoicePoolIdentities();
  const monitor = new VoiceMonitor({
    guildId, isActive: () => true, timers: false, now: () => now, identities,
    settings: async () => settings, rooms: async () => currentRooms, helpers: async () => helpers,
    main, createHelper: cred => {
      const bot = new FakeVoiceBot(cred.id, cred.userId, initial.helperLogin?.(cred.id) ?? 'ready');
      made.set(cred.id, bot);
      return bot;
    },
    decoder: fakeDecoder(packet => sineFrame(packet[1] === 1 ? -3 : -40)),
    recorder: {
      async recover() {},
      async start(target) {
        const entry = { target, writes: [] as string[], stopped: null as string | null, handle: undefined as unknown as RecordingHandle };
        const startedAtMs = now;
        entry.handle = { startedAtMs, write: userId => { entry.writes.push(userId); }, offsetMs: at => at - startedAtMs,
          async stop(reason) { entry.stopped = reason ?? 'stopped'; } };
        recordings.push(entry);
        return entry.handle;
      }
    },
    appendFlag: async input => { flags.push(input); },
    publish: state => published.push(state),
    postNotice: async (channelId, text) => { if (noticeFails) throw new Error('Missing Permissions'); notices.push({ channelId, text }); },
    audit: async input => { audits.push({ kind: input.kind, payload: input.payload ?? {} }); },
    notifyOrganizer: async (_channel, text) => { organizer.push(text); },
    log: message => logs.push(message)
  });
  return {
    monitor, main, made, flags, published, notices, organizer, logs, recordings, identities, audits,
    last: () => published.at(-1)!,
    set noticeFails(value: boolean) { noticeFails = value; },
    tick(ms: number) { now += ms; return now; },
    set settings(value: ModerationSettingsBodyDto) { settings = value; },
    set helpers(value: VoiceBotCredential[]) { helpers = value; },
    set rooms(value: VoiceRoomInfo[]) { currentRooms = value; }
  };
}

const room = (matchId: MatchId, judgeCall: boolean): CoverageRoom =>
  ({ matchId, channelId: `c-${matchId}`, judgeCall, record: true, monitor: false });

test('assignment policy: judge-call rooms first, sticky otherwise, the rest reported unmonitored', () => {
  const first = planVoiceAssignments([room('M1', false), room('M2', true), room('M3', false)], ['main', 'h1'], new Map());
  assert.deepEqual([...first.rooms], [['M2', 'main'], ['M1', 'h1'], ['M3', null]]);
  // A covered room keeps its bot.
  const sticky = planVoiceAssignments([room('M1', false), room('M2', false)], ['main', 'h1'], new Map([['h1', 'M1' as MatchId], ['main', 'M2' as MatchId]]));
  assert.equal(sticky.rooms.get('M1'), 'h1');
  assert.equal(sticky.rooms.get('M2'), 'main');
  // A judge call takes the bot from an ordinary room when none is free.
  const reclaimed = planVoiceAssignments([room('M1', false), room('M2', true)], ['main'], new Map([['main', 'M1' as MatchId]]));
  assert.deepEqual([...reclaimed.rooms], [['M2', 'main'], ['M1', null]]);
});

test('judge-call recording: joins, subscribes the seated players only, records, posts one notice, leaves on resolve', async () => {
  const h = harness();
  await h.monitor.start();
  assert.equal(h.main.handles.length, 0, 'nothing is covered before a judge call');
  assert.deepEqual(h.last()!.rooms, []);
  await h.monitor.judgeCalled(eventId, 'M2');
  const handle = h.main.active!;
  assert.equal(handle.channelId, '400000000000000002');
  assert.deepEqual(handle.subscribed.sort(), [P.c, P.d]);
  assert.ok(!handle.subscribed.includes(SPECTATOR));
  handle.emit(SPECTATOR, Buffer.from([0xfc, 1]));
  handle.emit(P.c, Buffer.from([0xfc, 0]));
  assert.deepEqual(h.recordings[0]!.writes, [P.c]);
  assert.deepEqual([...h.recordings[0]!.target.playerIds].sort(), [P.c, P.d]);
  assert.deepEqual(h.notices, [{ channelId: '400000000000000002', text: DEFAULT_MONITOR_NOTICE }]);
  assert.deepEqual(h.last()!.rooms, [{ matchId: 'M2', channelId: '400000000000000002', botId: 'main', status: 'recording' }]);
  assert.equal(h.last()!.bots.main!.status, 'connected');
  await h.monitor.schedule();
  assert.equal(h.notices.length, 1, 'the notice is posted once per activation');
  await h.monitor.matchResolved(eventId, 'M2');
  assert.equal(handle.left, true);
  assert.equal(h.recordings[0]!.stopped, 'not needed');
  assert.deepEqual(h.last()!.rooms, []);
  await h.monitor.stop();
  assert.equal(h.published.at(-1), null);
});

test('pool: a room without a free bot is unmonitored; adding a helper covers it (lazy login); removing it frees the room', async () => {
  const h = harness({ settings: settingsWith({ recording: { mode: 'always' } }) });
  await h.monitor.start();
  assert.deepEqual(h.last()!.rooms.map(item => [item.matchId, item.botId, item.status]), [['M1', 'main', 'recording'], ['M2', null, 'unmonitored']]);
  h.helpers = [credential('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '600000000000000001')];
  await h.monitor.helpersChanged();
  const helper = h.made.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')!;
  assert.equal(helper.loginCalls, 1);
  assert.equal(helper.active?.channelId, '400000000000000002');
  assert.ok(h.identities.has('600000000000000001') && h.identities.has('500000000000000000'));
  assert.deepEqual(h.last()!.rooms.map(item => item.botId), ['main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  // A judge call in M2 keeps its bot; an unrelated bot never hops.
  await h.monitor.judgeCalled(eventId, 'M2');
  assert.equal(h.main.handles.length, 1);
  h.helpers = [];
  await h.monitor.helpersChanged();
  assert.equal(helper.destroyed, 1);
  assert.equal(helper.active, undefined);
  assert.ok(!h.identities.has('600000000000000001'));
  // M2 (judge call) now outranks M1: the main bot moves there and M1 is reported unmonitored.
  assert.deepEqual(h.last()!.rooms.map(item => [item.matchId, item.botId]), [['M1', null], ['M2', 'main']]);
  assert.equal(h.main.active?.channelId, '400000000000000002');
  await h.monitor.stop();
});

test('helpers are not logged in while the main bot is enough', async () => {
  const h = harness({ settings: settingsWith({}), helpers: [credential('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '600000000000000002')] });
  await h.monitor.start();
  await h.monitor.judgeCalled(eventId, 'M1');
  assert.equal(h.made.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')!.loginCalls, 0);
  await h.monitor.stop();
});

test('closing the judge request ends the judge-call recording and leaves the room', async () => {
  const h = harness();
  await h.monitor.start();
  await h.monitor.judgeCalled(eventId, 'M2');
  const handle = h.main.active!;
  assert.equal(handle.left, false);
  await h.monitor.judgeClosed(eventId, 'M2');
  assert.equal(handle.left, true);
  assert.equal(h.recordings[0]!.stopped, 'not needed');
  assert.deepEqual(h.last()!.rooms, []);
  await h.monitor.stop();
});

test('a loudness spike flags with the recording offset, never mutes, and notifies the organizer at a limited rate', async () => {
  const h = harness({ settings: settingsWith({ voice: { enabled: true, notifyDiscord: true }, noticeText: 'Custom notice' }) });
  await h.monitor.start();
  await h.monitor.judgeCalled(eventId, 'M1');
  const handle = h.main.active!;
  assert.equal(h.notices[0]!.text, 'Custom notice');
  const recordingStart = h.recordings[0]!.handle.startedAtMs;
  h.tick(5_000);
  for (let index = 0; index < 30; index += 1) { h.tick(20); handle.emit(P.a, Buffer.from([0xfc, 1])); }
  assert.equal(h.flags.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  const flag = h.flags[0]!;
  assert.equal(flag.kind, 'volume');
  assert.deepEqual([flag.userId, flag.matchId, flag.channelId, flag.eventId], [P.a, 'M1', '400000000000000001', eventId]);
  assert.ok(flag.kind === 'volume' && flag.detail.recordingOffsetMs === 5_020 && flag.occurredAtMs === recordingStart + 5_020);
  assert.ok(flag.kind === 'volume' && flag.detail.sustainedMs >= 400 && flag.detail.thresholdDbfs === -8);
  assert.equal(h.organizer.length, 1);
  // A second player's spike within the notice interval is flagged but not re-notified.
  for (let index = 0; index < 30; index += 1) { h.tick(20); handle.emit(P.b, Buffer.from([0xfc, 1])); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.flags.length, 2);
  assert.equal(h.organizer.length, 1);
  await h.monitor.stop();
});

test('monitoring only (no recording) leaves the offset null', async () => {
  const h = harness({ settings: settingsWith({ recording: { mode: 'off' }, voice: { enabled: true, scope: 'always' } }) });
  await h.monitor.start();
  assert.deepEqual(h.last()!.rooms.map(item => item.status), ['monitored', 'unmonitored']);
  for (let index = 0; index < 30; index += 1) { h.tick(20); h.main.active!.emit(P.b, Buffer.from([0xfc, 1])); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.recordings.length, 0);
  assert.ok(h.flags[0]!.kind === 'volume' && h.flags[0]!.detail.recordingOffsetMs === null);
  await h.monitor.stop();
});

test('an invalid helper token fails only that bot, and no token ever reaches logs, published state or serialization', async () => {
  const bad = credential('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '600000000000000003', 'q');
  const good = credential('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '600000000000000004', 'z');
  const h = harness({ settings: settingsWith({ recording: { mode: 'always' } }), helpers: [bad, good],
    helperLogin: id => id === bad.id ? 'login failed' : 'ready' });
  await h.monitor.start();
  const state = h.last()!;
  assert.equal(state.bots[bad.id]!.status, 'login failed');
  assert.equal(state.bots[good.id]!.status, 'connected');
  assert.deepEqual(state.rooms.map(item => item.botId), ['main', good.id]);
  h.main.failJoin = true;
  await h.monitor.stop();
  const everything = JSON.stringify({ published: h.published, logs: h.logs, notices: h.notices });
  for (const secret of [bad.token, good.token]) {
    assert.ok(!everything.includes(secret));
    assert.ok(!everything.includes(secret.split('.')[2]!));
  }
  const transport = new HelperBotTransport(bad.id, bad.token, guildId, bad.userId);
  assert.ok(!JSON.stringify(transport).includes(bad.token));
  assert.ok(!String(Object.values(transport)).includes(bad.token));
});

test('a failed join is reported token-free and retried later, not in a loop', async () => {
  const h = harness({ settings: settingsWith({ recording: { mode: 'always' } }) });
  h.main.failJoin = true;
  await h.monitor.start();
  assert.equal(h.main.handles.length, 0);
  assert.equal(h.last()!.bots.main!.status, 'error');
  assert.ok(h.last()!.rooms.every(item => item.status === 'unmonitored'));
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /could not join match room M1/);
  h.main.failJoin = false;
  h.tick(31_000);
  await h.monitor.schedule();
  assert.equal(h.main.active?.channelId, '400000000000000001');
  await h.monitor.stop();
});

test('consent: nothing is subscribed or recorded until the notice posts; a failed notice is audited once', async () => {
  const h = harness({ settings: settingsWith({ recording: { mode: 'always' } }) });
  h.noticeFails = true;
  await h.monitor.start();
  const handle = h.main.active!;
  assert.ok(handle, 'the bot joins the room');
  assert.deepEqual(handle.subscribed, [], 'no player is subscribed without a posted notice');
  assert.equal(h.recordings.length, 0, 'no recording starts without a posted notice');
  await h.monitor.schedule();
  assert.equal(h.audits.filter(entry => entry.kind === 'voice.notice_failed').length, 1, 'the failure is audited once');
  h.noticeFails = false;
  await h.monitor.schedule();
  assert.equal(h.notices.length, 1);
  assert.deepEqual([...handle.subscribed].sort(), [P.a, P.b]);
  assert.equal(h.recordings.length, 1, "'always' mode records once the notice is up");
  await h.monitor.stop();
});
