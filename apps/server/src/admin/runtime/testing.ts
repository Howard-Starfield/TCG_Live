// Shared test helpers (not a test file: the test glob matches *.test.js only).
import type { AuditEntryDto } from '@tcg-live/core';
import { ADMIN, createFixture, createSignupFixture, transition, type Command, type EventState } from '../../rehearsal/domain.js';
import type { SessionIdentity } from '../../discord/session.js';
import { mapAuditRow, type AdminAuditRow, type AdminSessionRow } from './mappers.js';

export const RUNNER = 'runner-1';
export const T0 = 1_800_000_000_000;
export const IDS = {
  admin: '800000000000000001',
  a: '800000000000000011', b: '800000000000000012', c: '800000000000000013', d: '800000000000000014',
  e: '800000000000000015',
  guild: '800000000000000100', channel: '800000000000000101', app: '800000000000000102'
} as const;
export const EVENT_ID = '11111111-1111-4111-8111-111111111111';

export interface StepOptions {
  at?: number;
  principalKind?: string | null;
  principalId?: string | null;
  commandId?: string;
  runnerId?: string;
}

/** Replays commands through the real transition() and records audit rows the way store.ts does. */
export class Replay {
  rows: AdminAuditRow[] = [];
  constructor(public state: EventState, public now = T0) {}

  static legacy(durationMs = 60_000): Replay { return new Replay(createFixture(EVENT_ID, durationMs)); }
  static signup(durationMs = 60_000): Replay { return new Replay(createSignupFixture(EVENT_ID, durationMs)); }

  run(actor: string, command: Command, options: StepOptions = {}): this {
    if (options.at !== undefined) this.now = options.at;
    const result = transition(this.state, actor, command, this.now, options.runnerId ?? RUNNER);
    if (!result.outcome.applied) return this;
    this.state = result.state;
    const timer = options.principalKind === 'system';
    this.rows.push({
      sequence: result.state.version,
      command_id: options.commandId ?? `discord:${900000000000000000n + BigInt(result.state.version)}`,
      actor_id: actor, action: command, outcome: result.outcome, occurred_at_ms: this.now,
      mode: 'matchId' in command ? 'CAM' : null,
      principal_kind: options.principalKind === undefined ? 'discord' : options.principalKind,
      principal_id: options.principalId === undefined ? (timer ? 'system:timer' : IDS.admin) : options.principalId
    });
    return this;
  }

  /** Advances the clock, then runs. */
  after(ms: number, actor: string, command: Command, options: StepOptions = {}): this {
    return this.run(actor, command, { ...options, at: this.now + ms });
  }

  /** The legacy fixture through publication with all four checked in. */
  published(): this {
    for (const seat of ['A', 'B', 'C', 'D'] as const) this.run(`player:${seat}`, { type: 'checkin' });
    return this.run(ADMIN, { type: 'publish' });
  }

  entries(): AuditEntryDto[] { return this.rows.map(mapAuditRow); }
}

export function legacyIdentity(): SessionIdentity {
  return { kind: 'legacy', players: { A: IDS.a, B: IDS.b, C: IDS.c, D: IDS.d }, adminId: IDS.admin };
}

export function sessionFor(state: EventState, overrides: Partial<AdminSessionRow> = {}): AdminSessionRow {
  return {
    event_id: state.id, application_id: IDS.app, guild_id: IDS.guild, channel_id: IDS.channel,
    identity_map: state.signup ? { kind: 'signup', adminId: IDS.admin } : legacyIdentity(),
    status: 'active', checkin_message_id: null, m1_message_id: null, m2_message_id: null,
    created_at_ms: T0 - 60_000, retired_at_ms: null,
    ...overrides
  };
}
