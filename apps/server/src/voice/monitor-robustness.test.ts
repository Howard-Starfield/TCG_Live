import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS, DEFAULT_VOICE_ROOM_POLICY, type MatchId, type ModerationSettingsBodyDto,
  type VoiceRoomPolicyDto } from '@tcg-live/core';
import { classifyLoginError, loginBackoffMs } from './connection.js';
import { VoicePoolIdentities } from './identities.js';
import { sineFrame } from './loudness.js';
import { REJOIN_WINDOW_MS, VoiceMonitor, type RecordingHandle, type VoiceRoomInfo } from './monitor.js';
import { planVoiceAssignments, type CoverageRoom } from './pool.js';
import type { RecordingTarget } from './recorder.js';
import { FakeVoiceBot, fakeDecoder, syntheticToken } from './testing.js';
import { tokenUserId, type VoiceBotCredential } from './tokens.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const P = { a: '200000000000000001', b: '200000000000000002', c: '200000000000000003', d: '200000000000000004', e: '200000000000000005' };
const C1 = '400000000000000001';
const C2 = '400000000000000002';
const baseRooms = (): VoiceRoomInfo[] => [
  { eventId, matchId: 'M1', voiceChannelId: C1, playerIds: [P.a, P.b], phase: 'running' },
  { eventId, matchId: 'M2', voiceChannelId: C2, playerIds: [P.c, P.d], phase: 'running' }
];
const HELPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential = (id: string, user: string, enabled = true): VoiceBotCredential => {
  const token = syntheticToken(user);
  return { id, label: 'Helper', token, userId: tokenUserId(token), addedAtMs: 1, applicationId: null, enabled, nickname: null };
};
const settingsWith = (patch: { mode?: ModerationSettingsBodyDto['recording']['mode']; optOut?: string[];
  rooms?: Record<string, VoiceRoomPolicyDto>; voice?: Partial<ModerationSettingsBodyDto['voice']> } = {}): ModerationSettingsBodyDto =>
  ({ ...DEFAULT_MODERATION_SETTINGS, recording: { mode: patch.mode ?? 'judge-call', optOutUserIds: patch.optOut ?? [] },
    voice: { ...DEFAULT_MODERATION_SETTINGS.voice, ...patch.voice, rooms: patch.rooms ?? {} } });

interface FakeRecording { target: RecordingTarget; handle: RecordingHandle; writes: string[]; stopped: string | null; gaps: Array<{ from: number; to: number; reason: string }>;
  players: string[]; active: boolean }

function harness(initial: { settings?: ModerationSettingsBodyDto; helpers?: VoiceBotCredential[]; failStarts?: number } = {}) {
  let now = 1_000_000;
  let settings = initial.settings ?? settingsWith();
  let helpers = initial.helpers ?? [];
  let currentRooms = baseRooms();
  let failStarts = initial.failStarts ?? 0;
  let hold: Promise<void> | null = null;
  const main = new FakeVoiceBot('main', '500000000000000000', 'ready', 'ready');
  const made = new Map<string, FakeVoiceBot>();
  const recordings: FakeRecording[] = [];
  const organizer: string[] = [];
  const monitor = new VoiceMonitor({
    guildId: '100000000000000001', isActive: () => true, timers: false, now: () => now, identities: new VoicePoolIdentities(),
    settings: async () => settings, rooms: async () => { if (hold) await hold; return currentRooms; }, helpers: async () => helpers,
    main, createHelper: cred => { const bot = new FakeVoiceBot(cred.id, cred.userId, 'ready'); made.set(cred.id, bot); return bot; },
    decoder: fakeDecoder(() => sineFrame(-40)),
    recorder: {
      async recover() {},
      async start(target) {
        if (failStarts > 0) { failStarts -= 1; throw new Error('storage full'); }
        const entry: FakeRecording = { target, writes: [], stopped: null, gaps: [], players: [...target.playerIds], active: true,
          handle: undefined as unknown as RecordingHandle };
        const startedAtMs = now;
        entry.handle = {
          startedAtMs, get active() { return entry.active; },
          write: userId => { entry.writes.push(userId); }, offsetMs: at => at - startedAtMs,
          players: () => [...entry.players],
          addPlayer: async userId => { entry.players.push(userId); return 'x'; },
          gap: async (from, to, reason) => { entry.gaps.push({ from, to, reason }); },
          async stop(reason) { entry.stopped ??= reason ?? 'stopped'; entry.active = false; }
        };
        recordings.push(entry);
        return entry.handle;
      }
    },
    appendFlag: async () => {}, publish: () => {}, postNotice: async () => {},
    notifyOrganizer: async (_channel, text) => { organizer.push(text); }, log: () => {}
  });
  return { monitor, main, made, recordings, organizer,
    tick(ms: number) { now += ms; return now; },
    set settings(value: ModerationSettingsBodyDto) { settings = value; },
    set helpers(value: VoiceBotCredential[]) { helpers = value; },
    set rooms(value: VoiceRoomInfo[]) { currentRooms = value; },
    set failStarts(value: number) { failStarts = value; },
    set hold(value: Promise<void> | null) { hold = value; } };
}

test('connection states: while not ready the recording gets an audited gap with its offset', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }) });
  await h.monitor.start();
  const handle = h.main.active!;
  h.tick(1_000);
  handle.setState('disconnected');
  h.tick(500);
  handle.setState('connecting');
  h.tick(1_500);
  handle.setState('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.recordings[0]!.gaps.map(gap => [gap.to - gap.from, gap.reason]), [[2_000, 'reconnecting']]);
  assert.equal(h.recordings[0]!.handle.offsetMs(h.recordings[0]!.gaps[0]!.from), 1_000);
  await h.monitor.stop();
});

test('a lost connection rejoins at once (no bench) and continues the same recording with a gap', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }) });
  await h.monitor.start();
  const first = h.main.active!;
  const recording = h.recordings[0]!;
  h.tick(5_000);
  first.lose();
  await new Promise(resolve => setTimeout(resolve, 5));
  await h.monitor.schedule();
  const second = h.main.active!;
  assert.notEqual(second, first, 'rejoined immediately');
  assert.equal(h.recordings.length, 1, 'no new recording');
  assert.equal(recording.stopped, null, 'the same session continues');
  assert.equal(recording.gaps.at(-1)!.reason, 'disconnected');
  second.emit(P.a, Buffer.from([0xfc, 0]));
  assert.ok(recording.writes.includes(P.a), 'packets go to the same recording');
  await h.monitor.stop();
});

test('a rejoin outside the window finalizes the old recording and starts a new one', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }) });
  await h.monitor.start();
  h.main.failJoin = true;
  h.main.active!.lose();
  await new Promise(resolve => setTimeout(resolve, 5));
  await h.monitor.schedule();
  assert.equal(h.recordings[0]!.stopped, null, 'kept while the window is open');
  h.tick(REJOIN_WINDOW_MS + 1);
  h.main.failJoin = false;
  await h.monitor.schedule();
  assert.equal(h.recordings[0]!.stopped, 'disconnected');
  assert.equal(h.recordings.length, 2);
  await h.monitor.stop();
});

test('a recording stopped for storage is retried with backoff once space is back', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }), failStarts: 0 });
  await h.monitor.start();
  h.recordings[0]!.active = false; // the recorder stopped it (storage full)
  h.failStarts = 1;
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 1, 'cleared, waiting 30 s');
  h.tick(31_000);
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 1, 'still full: refused, backoff doubles');
  h.tick(31_000);
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 1, 'waits out the doubled backoff');
  h.tick(30_000);
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 2, 'restarted after the backoff');
  await h.monitor.stop();
});

test('a player seated mid-recording is added; an opted-out player is never subscribed or recorded', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always', optOut: [P.b] }) });
  await h.monitor.start();
  const handle = h.main.active!;
  assert.deepEqual(handle.subscribed, [P.a]);
  assert.deepEqual(h.recordings[0]!.target.playerIds, [P.a]);
  handle.emit(P.b, Buffer.from([0xfc, 0]));
  assert.deepEqual(h.recordings[0]!.writes, []);
  h.rooms = [{ ...baseRooms()[0]!, playerIds: [P.a, P.b, P.e] }, baseRooms()[1]!];
  await h.monitor.schedule();
  assert.deepEqual(h.recordings[0]!.players.sort(), [P.a, P.e].sort());
  assert.ok(!handle.subscribed.includes(P.b));
  await h.monitor.stop();
});

test('room policy: never is left, recording always overrides judge-call, a pinned helper goes to its room', async () => {
  const h = harness({ settings: settingsWith({ rooms: { [C2]: { ...DEFAULT_VOICE_ROOM_POLICY, recording: 'always' } } }),
    helpers: [credential(HELPER, '600000000000000001')] });
  await h.monitor.start();
  assert.equal(h.recordings.length, 1, 'M2 records although the global mode is judge-call');
  assert.equal(h.recordings[0]!.target.matchId, 'M2');
  assert.equal(h.main.active?.channelId, C2);
  h.settings = settingsWith({ mode: 'always', rooms: { [C1]: { ...DEFAULT_VOICE_ROOM_POLICY, pinnedBotId: HELPER } } });
  await h.monitor.schedule();
  assert.equal(h.made.get(HELPER)!.active?.channelId, C1, 'pinned helper covers M1');
  h.settings = settingsWith({ mode: 'always', rooms: { [C2]: { ...DEFAULT_VOICE_ROOM_POLICY, coverage: 'never' } } });
  await h.monitor.schedule();
  assert.equal(h.recordings[0]!.stopped !== null, true);
  assert.ok(![h.main.active?.channelId, h.made.get(HELPER)!.active?.channelId].includes(C2), 'no bot in a never room');
  await h.monitor.stop();
});

test('disabled helpers are never logged in; retry clears a failure', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }), helpers: [credential(HELPER, '600000000000000001', false)] });
  await h.monitor.start();
  assert.equal(h.made.size, 0);
  h.helpers = [credential(HELPER, '600000000000000001', true)];
  await h.monitor.helpersChanged();
  assert.equal(h.made.get(HELPER)!.active?.channelId, C2);
  assert.equal(await h.monitor.retryBot(HELPER), true);
  assert.equal(h.made.get(HELPER)!.resets, 1);
  assert.equal(await h.monitor.retryBot('nope'), false);
  await h.monitor.stop();
});

test('shutdown stops all recordings in parallel', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }), helpers: [credential(HELPER, '600000000000000001')] });
  await h.monitor.start();
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 2);
  await h.monitor.stop();
  assert.ok(h.recordings.every(item => item.stopped === 'shutdown'));
});

test('shutdown does not wait for a tick stuck in a voice join before stopping the recordings', async () => {
  const h = harness({ settings: settingsWith({ mode: 'always' }), helpers: [credential(HELPER, '600000000000000001')] });
  await h.monitor.start();
  await h.monitor.schedule();
  assert.equal(h.recordings.length, 2);
  h.hold = new Promise<void>(() => {});   // The next reconcile never finishes (a hung join).
  void h.monitor.schedule();
  const started = Date.now();
  await h.monitor.stop();
  assert.ok(Date.now() - started < 2_000, 'stop did not wait for the stuck tick');
  assert.ok(h.recordings.every(item => item.stopped === 'shutdown'));
});

const room = (matchId: MatchId, extra: Partial<CoverageRoom> = {}): CoverageRoom =>
  ({ matchId, channelId: `c-${matchId}`, judgeCall: false, record: true, monitor: false, ...extra });

test('planner: judge calls, then high, then normal; pins win; only a judge call takes a pinned bot', () => {
  const ordered = planVoiceAssignments([room('M1'), room('M2', { priority: 'high' }), room('M3', { judgeCall: true })], ['main', 'h1'], new Map());
  assert.deepEqual([...ordered.rooms], [['M3', 'main'], ['M2', 'h1'], ['M1', null]]);
  // A high room takes a sticky bot from a normal room.
  const high = planVoiceAssignments([room('M1'), room('M2', { priority: 'high' })], ['main'], new Map([['main', 'M1' as MatchId]]));
  assert.deepEqual([...high.rooms], [['M2', 'main'], ['M1', null]]);
  // A pin moves the helper to its room even if it was elsewhere.
  const pinned = planVoiceAssignments([room('M1'), room('M2', { pinnedBotId: 'h1' })], ['main', 'h1'], new Map([['h1', 'M1' as MatchId]]));
  assert.equal(pinned.rooms.get('M2'), 'h1');
  assert.equal(pinned.rooms.get('M1'), 'main');
  // A high room cannot take a pinned bot; a judge call can.
  const pinHeld = planVoiceAssignments([room('M1', { pinnedBotId: 'h1' }), room('M2', { priority: 'high' })], ['h1'], new Map());
  assert.equal(pinHeld.rooms.get('M1'), 'h1');
  assert.equal(pinHeld.rooms.get('M2'), null);
  const judge = planVoiceAssignments([room('M1', { pinnedBotId: 'h1' }), room('M2', { judgeCall: true })], ['h1'], new Map());
  assert.equal(judge.rooms.get('M2'), 'h1');
  // A pin to an unavailable (disabled, missing) bot is ignored.
  const missing = planVoiceAssignments([room('M1', { pinnedBotId: 'gone' })], ['main'], new Map());
  assert.equal(missing.rooms.get('M1'), 'main');
});

test('login failures: an invalid token stays failed, anything else backs off from 30 s to 5 min', () => {
  assert.equal(classifyLoginError(Object.assign(new Error('x'), { code: 'TokenInvalid' })), 'invalid-token');
  assert.equal(classifyLoginError({ code: 4004 }), 'invalid-token');
  assert.equal(classifyLoginError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'network');
  assert.equal(classifyLoginError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(classifyLoginError(new Error('anything')), 'unknown');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(loginBackoffMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  // A 60 s outage at startup: retries at +30 s and +60 s later, so the helper recovers within about 90 s.
  assert.ok(loginBackoffMs(1) + loginBackoffMs(2) <= 120_000);
});
