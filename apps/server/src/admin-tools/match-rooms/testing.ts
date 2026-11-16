// Test harness for the match room pool: a synthetic server (the demo guild), a manual clock, a rename transport that records
// what it sends, in-memory bindings and transcripts. Nothing here touches Discord or a database.
import type { MatchId, MemberDto } from '@tcg-live/core';
import { createDemoGuild, type DemoGuild } from '../demo-guild.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import type { RoomOverwrite } from '../../discord/match-rooms.js';
import { demoMatchRoomDiscord } from './port.js';
import type { PreviousBinding, RoomBindings } from './pool.js';
import type { QueueClock } from './renames.js';
import { createMatchRoomSystem, type ActiveEventInfo, type MatchRoomSystem, type MatchRoomSystemInput } from './service.js';
import { MemoryMatchRoomStore, type MatchRoomStore } from './store.js';
import { MemoryTranscriptStore, type RoomChatPort } from './transcripts.js';

export const TEST_GUILD = '100000000000000001';
export const TEST_APP = '910000000000000000';
export const TEST_ADMIN = '910000000000000001';
export const TEST_BOT = '200000000000000099';

/** A clock that only moves when told to; timers run in order as it passes them. */
export class FakeQueueClock implements QueueClock {
  private nowMs: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  constructor(start = 1_800_000_000_000) { this.nowMs = start; }
  now(): number { return this.nowMs; }
  setTimeout(callback: () => void, ms: number): unknown { const id = ++this.seq; this.timers.set(id, { at: this.nowMs + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  /** Moves time forward, firing every timer that comes due on the way (one at a time, each at its own instant). */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = Math.max(this.nowMs, next[1].at);
      next[1].callback();
    }
    this.nowMs = target;
  }
  /** When the next timer is due, or null. */
  nextAt(): number | null { return [...this.timers.values()].reduce<number | null>((least, timer) => least === null || timer.at < least ? timer.at : least, null); }
  get pending(): number { return this.timers.size; }
}

/** Lets queued promise callbacks run (the queue's timer starts an async pass). */
export async function flush(times = 20): Promise<void> { for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

/** Per-event bindings (what identity_map.roundRooms holds) and the history `previous` reads. */
export class TestBindings implements RoomBindings {
  readonly sessions = new Map<string, Partial<Record<MatchId, string>>>();
  readonly order: string[] = [];
  /** Older sessions have no record of when a room was bound: previous() then has no start. */
  unknownStart = false;
  private readonly history: Array<{ channelId: string } & PreviousBinding> = [];
  constructor(private readonly clock: () => number) {}
  async bind(eventId: string, matchId: MatchId, channelId: string): Promise<void> {
    this.sessions.set(eventId, { ...this.sessions.get(eventId), [matchId]: channelId });
    this.history.push({ channelId, eventId, matchId, startedAtMs: this.clock() });
    this.order.push(`bind:${channelId}`);
  }
  async previous(channelId: string, exceptEventId: string): Promise<PreviousBinding | null> {
    const found = [...this.history].reverse().find(item => item.channelId === channelId && item.eventId !== exceptEventId);
    return found ? { eventId: found.eventId, matchId: found.matchId, startedAtMs: this.unknownStart ? null : found.startedAtMs } : null;
  }
}

export interface RenameCall { channelId: string; name: string; at: number }

export function roomWorld(options: { store?: MatchRoomStore; demo?: DemoGuild; clock?: FakeQueueClock; legacy?: Partial<Record<MatchId, string>> } = {}) {
  const demo = options.demo ?? createDemoGuild(TEST_GUILD);
  // The demo guild starts with two voice rooms; the tests that want an empty server remove them.
  const occupants = new Map<string, MemberDto[]>();
  const discord = demoMatchRoomDiscord(demo, { botId: TEST_BOT, occupants: channelId => occupants.get(channelId) ?? [] });
  const store = options.store ?? new MemoryMatchRoomStore();
  const clock = options.clock ?? new FakeQueueClock();
  const bindings = new TestBindings(() => clock.now());
  const audit = new MemoryOpsAuditStore();
  const transcripts = new MemoryTranscriptStore(() => clock.now());
  const renames: RenameCall[] = [];
  const world = {
    demo, discord, store, clock, bindings, audit, transcripts, renames, occupants,
    /** Throw this from the next rename of a channel (and keep doing so until cleared). */
    renameFailure: null as ((channelId: string) => unknown) | null,
    /** Runs inside a rename, before it completes (to simulate a request arriving while one is in flight). */
    duringRename: null as ((channelId: string, name: string) => Promise<void>) | null,
    chatLog: [] as string[],
    chatMessages: new Map<string, number>(),
    warnings: [] as string[],
    backups: [] as Array<{ channelId: string; overwrites: readonly RoomOverwrite[] }>,
    event: null as ActiveEventInfo | null,
    system: undefined as unknown as MatchRoomSystem
  };
  const chat: RoomChatPort = {
    async fetchMessages(channelId) {
      world.chatLog.push(`archive:${channelId}`);
      bindings.order.push(`archive:${channelId}`);
      const count = world.chatMessages.get(channelId) ?? 0;
      return { contentAvailable: true, messages: Array.from({ length: count }, (_, index) => ({ id: `${500_000_000_000_000_000n + BigInt(index)}`, authorId: '1',
        authorName: 'Player', createdAtMs: clock.now() - 1_000 * (count - index), content: `message ${index}`, attachments: [] })) };
    },
    async bulkDelete(channelId, ids) { world.chatLog.push(`clear:${channelId}`); world.chatMessages.set(channelId, 0); return { deleted: ids.length, skippedOld: 0 }; }
  };
  const build = (extra: Partial<MatchRoomSystemInput> = {}): MatchRoomSystem => createMatchRoomSystem({
    guildId: TEST_GUILD, applicationId: TEST_APP, adminId: TEST_ADMIN, store, discord, clock, now: () => clock.now(),
    renamer: { async rename(channelId, name) {
      renames.push({ channelId, name, at: clock.now() });
      await world.duringRename?.(channelId, name);
      const failure = world.renameFailure?.(channelId);
      if (failure) throw failure;
      discord.rename(channelId, name);
    } },
    bindings, ...(options.legacy ? { legacyChannels: () => options.legacy } : {}),
    activeEvent: async () => world.event, backup: async (_guild, channelId, overwrites) => { world.backups.push({ channelId, overwrites }); },
    readBackup: async () => null, chat, transcripts, audit, warn: message => world.warnings.push(message), ...extra });
  world.system = build();
  return Object.assign(world, { build,
    /** Publishes `count` matches of an event, the way a round publishes: M1..Mcount, each a pair of two made-up players. */
    async publish(eventId: string, count: number, naming: { eventName?: string | null; gameLabel?: string | null } = {}, system = world.system) {
      const matches = Array.from({ length: count }, (_, index) => ({ id: `M${index + 1}` as MatchId, pair: [`3000000000000${String(index * 2 + 1).padStart(5, '0')}`,
        `3000000000000${String(index * 2 + 2).padStart(5, '0')}`] }));
      return system.pool.provision({ eventId, eventName: naming.eventName ?? 'Spring Open', gameLabel: naming.gameLabel === undefined ? 'One Piece' : naming.gameLabel,
        round: 1, matches, savedRooms: { ...bindings.sessions.get(eventId) } });
    },
    channelNamed: (name: string) => demo.channels.find(channel => channel.name === name),
    voiceCount: () => demo.channels.filter(channel => channel.type === 'voice').length });
}

/** The two rooms the demo guild starts with are in the way of tests about an empty server. */
export function withoutDemoRooms(demo: DemoGuild): DemoGuild {
  demo.channels = demo.channels.filter(channel => channel.type !== 'voice');
  return demo;
}
