import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMatchRooms, demoOpsOptions, DEMO_GUILD_ID, runAdminDemo } from '../demo.js';
import { call } from '../http/test-support.js';
import { attachMatchRoomService, currentMatchRoomService, type MatchRoomService } from '../../admin-tools/match-rooms/service-port.js';
import { DEMO_CHANNEL_IDS } from '../../admin-tools/demo-guild.js';
import { DEMO_MATCH_CHANNELS, DemoAdminRuntime, type DemoClock } from './demo-runtime.js';

class Clock implements DemoClock {
  private timers = new Map<number, { at: number; callback: () => void }>();
  private id = 0;
  constructor(public t = 1_800_000_000_000) {}
  now() { return this.t; }
  setTimeout(callback: () => void, ms: number) { this.timers.set(++this.id, { at: this.t + ms, callback }); return this.id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].callback();
    }
    this.t = end;
  }
}

test('the demo pool is the single source of room IDs: the legacy fixture, the demo server and a published round agree', async () => {
  assert.deepEqual(DEMO_MATCH_CHANNELS, { M1: DEMO_CHANNEL_IDS.matchM1, M2: DEMO_CHANNEL_IDS.matchM2 });
  const ops = demoOpsOptions();
  const demo = ops.adminTools!.demo!;
  assert.deepEqual(demo.channels.filter(channel => channel.type === 'voice').map(channel => channel.name), ['🎮 M1', '🎮 M2']);
  let runtime: DemoAdminRuntime | undefined;
  const system = (await demoMatchRooms(ops, () => runtime))!;
  await system.start();
  const clock = new Clock();
  runtime = new DemoAdminRuntime({ clock, playerCount: 8, rooms: { provision: ({ eventId, matches }) => system.pool.provision({
    eventId, eventName: null, gameLabel: 'One Piece', round: 1, matches: matches.map(id => ({ id, pair: [] })), savedRooms: {} }) } });
  try {
    runtime.start();
    clock.advance(12_000);
    for (let tick = 0; tick < 50; tick++) await new Promise<void>(resolve => setImmediate(resolve));
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.matches.length, 4);
    const rooms = Object.values(snapshot.discord.matchChannels ?? {});
    assert.equal(new Set(rooms).size, 4);
    const dto = await system.service.describe();
    assert.deepEqual(dto.rooms.map(room => room.channelId).sort(), [...rooms].sort(), 'the dashboard\'s rooms are the pool\'s');
    assert.ok(rooms.includes(DEMO_CHANNEL_IDS.matchM1) && rooms.includes(DEMO_CHANNEL_IDS.matchM2), 'M1 and M2 are the demo server\'s own voice rooms');
    assert.equal(demo.channels.filter(channel => channel.type === 'voice').length, 4, 'tables 3 and 4 were created on the demo server');
    assert.equal(snapshot.discord.matchChannels?.M3, runtime.roomContext().roundRooms.M3);
  } finally { await runtime.close(); await system.stop(); }
});

test('a demo started while a live room service is attached never reaches the live service', async () => {
  const touched: string[] = [];
  const live = new Proxy({} as MatchRoomService, { get: (_target, name) => { touched.push(String(name)); return async () => { throw new Error('live service reached'); }; } });
  attachMatchRoomService(live);
  const demo = await runAdminDemo({ ephemeral: true, write: () => {} });
  try {
    const url = new URL(demo.handler.rotateLoginUrl()!);
    const grant = await call(demo.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: url.hash.slice('#login='.length) }) });
    assert.equal(grant.status, 200, grant.text);
    const token = grant.json().token as string;
    const base = '/api/v1/admin-tools/match-rooms';
    const described = await call(demo.port, base, { token });
    assert.equal(described.status, 200, described.text);
    assert.equal(described.json().guildId, DEMO_GUILD_ID, 'the demo answers from its own pool');
    assert.equal(described.json().rooms.length, 2);
    assert.equal((await call(demo.port, `${base}/cleanup`, { token })).status, 200);
    assert.equal((await call(demo.port, `${base}/ensure`, { method: 'POST', token, body: JSON.stringify({ tables: 3 }) })).status, 200);
    assert.deepEqual(touched, [], 'nothing touched the live service');
    assert.equal(currentMatchRoomService(), live, 'and the demo did not replace or detach it');
  } finally { await demo.stop(); attachMatchRoomService(null); }
});

test('the demo scripted event: after it publishes, its rooms show as assigned, in use, skipped by clean-up and bound for the archive', async () => {
  const ops = demoOpsOptions();
  let runtime: DemoAdminRuntime | undefined;
  const system = (await demoMatchRooms(ops, () => runtime))!;
  await system.start();
  const clock = new Clock();
  runtime = new DemoAdminRuntime({ clock, rooms: { provision: ({ eventId, matches }) => system.pool.provision({
    eventId, eventName: null, gameLabel: 'One Piece', round: 1, matches: matches.map(id => ({ id, pair: [] })), savedRooms: {} }) } });
  try {
    runtime.start();
    clock.advance(40_000);
    for (let tick = 0; tick < 50; tick++) await new Promise<void>(resolve => setImmediate(resolve));
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.published, true);
    const dto = await system.service.describe();
    assert.equal(dto.activeEventId, snapshot.eventId);
    assert.deepEqual(dto.rooms.map(room => room.assignedMatch), ['M1', 'M2']);
    assert.ok(dto.rooms.every(room => /In use by M[12]/.test(room.removeBlockedReason ?? '')));
    assert.equal(dto.storage, 'demo');
    assert.equal(dto.problem, null);
    const plan = await system.service.cleanupPlan();
    assert.ok(plan.items.filter(item => item.kind === 'room').every(item => item.action === 'skip' && /active event/.test(item.reason)));
  } finally { await runtime.close(); await system.stop(); }
});
