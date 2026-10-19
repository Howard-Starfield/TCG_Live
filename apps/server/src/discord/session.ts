import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createFixture, createSignupFixture, RuleError, type EventState, type MatchId, type Player } from '../rehearsal/domain.js';
import { rehearsalClient, transaction, verifyState, withClient } from '../rehearsal/store.js';
import { publicConfig, sameIdentityMap, type PrivateDiscordConfig } from './config.js';

export type CardSlot = 'checkin' | 'M1' | 'M2';
type SessionMetadata = { adminId: string; matchChannels?: Record<MatchId, string>;
  publicMatchRooms?: boolean;
  stickySuspended?: CardSlot[]; resumeReminderGeneration?: Partial<Record<MatchId, number>> };
export type SessionIdentity = SessionMetadata & (
  | { kind: 'signup'; players?: never }
  | { kind: 'legacy'; players: Record<Player, string> }
  | { kind?: undefined; players: Record<Player, string> }
);
export interface SessionRow {
  event_id: string;
  application_id: string;
  guild_id: string;
  channel_id: string;
  identity_map: SessionIdentity;
  status: 'active' | 'retired';
  checkin_message_id: string | null;
  m1_message_id: string | null;
  m2_message_id: string | null;
}

const columns: Record<CardSlot, 'checkin_message_id' | 'm1_message_id' | 'm2_message_id'> = {
  checkin: 'checkin_message_id', M1: 'm1_message_id', M2: 'm2_message_id'
};

export function messageId(session: SessionRow, slot: CardSlot): string | null {
  return session[columns[slot]];
}

export function assertSessionConfig(session: SessionRow, config: PrivateDiscordConfig): void {
  if (session.application_id !== config.applicationId || session.guild_id !== config.guildId ||
      session.channel_id !== config.channelId ||
      !sameIdentityMap(session.identity_map, config)) {
    throw new RuleError('Private Discord configuration differs from the saved session.');
  }
}

export function resolvePlayers(session: SessionRow, state: EventState): Record<Player, string> | null {
  const kind = session.identity_map.kind ?? 'legacy';
  if ((kind === 'signup') !== !!state.signup || (kind === 'signup') !== (state.schemaVersion === 2))
    throw new RuleError('Private Discord session and aggregate identity differ.');
  if (kind === 'signup') {
    if (session.identity_map.players || state.signup?.roster.includes(session.identity_map.adminId))
      throw new RuleError('Signup roster conflicts with frozen admin identity.');
    return state.signup?.status === 'assigned' ? state.signup.assignment ?? null : null;
  }
  if (!session.identity_map.players) throw new RuleError('Legacy session player identity is missing.');
  return session.identity_map.players;
}

export async function requireDiscordSchema(client: pg.Client): Promise<void> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM public.tcg_rehearsal_meta WHERE key = 'schema_version'"
  );
  if (result.rows[0]?.value !== '2') throw new RuleError('Private Discord schema migration is required.');
}

export interface AdvisoryLease {
  release(): Promise<void>;
  isLost(): boolean;
}

export async function acquireAdvisoryLease(config: PrivateDiscordConfig, onLost: () => void = () => {}): Promise<AdvisoryLease> {
  const client = rehearsalClient();
  let lost = false;
  let releasing = false;
  let released: Promise<void> | undefined;
  const markLost = () => {
    if (releasing || lost) return;
    lost = true;
    onLost();
  };
  client.on('error', markLost);
  client.on('end', markLost);
  try {
    await client.connect();
    await requireDiscordSchema(client);
    // The fixture permits one active session database-wide, so ownership must
    // use the same key even when someone attempts to change target settings.
    const key = 'single-active-session';
    const locked = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('tcg_live_private'), hashtext($1)) AS acquired", [key]
    );
    if (!locked.rows[0]?.acquired) throw new RuleError('Private Discord session is already owned by another process.');
    return {
      isLost: () => lost,
      release(): Promise<void> {
        if (released) return released;
        releasing = true;
        released = (async () => {
          try { await client.query("SELECT pg_advisory_unlock(hashtext('tcg_live_private'), hashtext($1))", [key]); }
          catch { /* Connection loss already released the lock. */ }
          await closeLeaseClient(client);
        })();
        return released;
      }
    };
  } catch (error) {
    await closeLeaseClient(client);
    if (error instanceof RuleError) throw error;
    throw new RuleError('Private Discord ownership check failed.');
  }
}

async function closeLeaseClient(client: pg.Client): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.end().catch(() => {}),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 2_000); })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    const connection = client as pg.Client & { connection?: { stream?: { destroy(): void } } };
    connection.connection?.stream?.destroy();
  }
}

export async function getActiveSession(config: PrivateDiscordConfig): Promise<SessionRow> {
  return withClient(async client => {
    await requireDiscordSchema(client);
    const row = await client.query<SessionRow>("SELECT * FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
    if (!row.rows[0]) throw new RuleError('No active private Discord session; run prepare first.');
    assertSessionConfig(row.rows[0], config);
    return row.rows[0];
  });
}

export async function getSessionState(config: PrivateDiscordConfig): Promise<{ session: SessionRow; state: EventState }> {
  return withClient(async client => {
    await requireDiscordSchema(client);
    const row = await client.query<SessionRow>("SELECT * FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
    const session = row.rows[0];
    if (!session) throw new RuleError('No active private Discord session; run prepare first.');
    assertSessionConfig(session, config);
    const event = await client.query<{ state: EventState; version: number }>(
      'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1', [session.event_id]
    );
    if (!event.rows[0]) throw new RuleError('Private Discord event is missing.');
    verifyState(event.rows[0].state, session.event_id, event.rows[0].version);
    resolvePlayers(session, event.rows[0].state);
    return { session, state: event.rows[0].state };
  });
}

export async function prepareSession(config: PrivateDiscordConfig, replace = false): Promise<SessionRow> {
  const lease = await acquireAdvisoryLease(config);
  try {
    return await withClient(client => transaction(client, async () => {
      if (lease.isLost()) throw new RuleError('Private Discord ownership was lost.');
      await requireDiscordSchema(client);
      const existing = await client.query<SessionRow>("SELECT * FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
      if (existing.rows[0]) {
        if (!replace) throw new RuleError('An active private Discord session already exists; use prepare --replace explicitly.');
        const old = existing.rows[0];
        await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [old.event_id]);
        await client.query("UPDATE public.tcg_rehearsal_sessions SET status = 'retired', retired_at_ms = $2 WHERE event_id = $1",
          [old.event_id, Date.now()]);
      }
      const event = config.mode === 'signup' ? createSignupFixture(randomUUID(), 60_000) : createFixture(randomUUID(), 60_000);
      await client.query('INSERT INTO public.tcg_rehearsal_events (id, version, state) VALUES ($1,$2,$3::jsonb)',
        [event.id, event.version, JSON.stringify(event)]);
      const session = await client.query<SessionRow>(
        "INSERT INTO public.tcg_rehearsal_sessions (event_id,application_id,guild_id,channel_id,identity_map,status,created_at_ms) VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6) RETURNING *",
        [event.id, config.applicationId, config.guildId, config.channelId,
          JSON.stringify({ kind: config.mode ?? 'legacy', ...(config.players ? { players: publicConfig(config).players } : {}), adminId: config.adminId,
            ...(config.matchChannels ? { matchChannels: config.matchChannels } : {}),
            ...(config.publicMatchRooms ? { publicMatchRooms: true } : {}) }), Date.now()]
      );
      if (lease.isLost()) throw new RuleError('Private Discord ownership was lost.');
      return session.rows[0]!;
    }));
  } finally {
    await lease.release();
  }
}

export async function prepareSignupSession(config: PrivateDiscordConfig, replace = false): Promise<SessionRow> {
  if (config.mode !== 'signup' || config.players) throw new RuleError('Signup preparation requires player-free signup configuration.');
  return prepareSession(config, replace);
}

export async function bindCard(config: PrivateDiscordConfig, eventId: string, slot: CardSlot, id: string): Promise<void> {
  if (!/^[1-9]\d{14,21}$/.test(id)) throw new RuleError('Invalid Discord message ID.');
  await withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    if (!row.rows[0] || row.rows[0].status !== 'active') throw new RuleError('Private Discord session is retired.');
    assertSessionConfig(row.rows[0], config);
    const identity = row.rows[0].identity_map;
    const stickySuspended = identity.stickySuspended?.filter(value => value !== slot) ?? [];
    await client.query(`UPDATE public.tcg_rehearsal_sessions SET ${columns[slot]} = $2, identity_map = $3::jsonb WHERE event_id = $1`,
      [eventId, id, JSON.stringify({ ...identity, stickySuspended })]);
  }));
}

export async function suspendStickyCard(config: PrivateDiscordConfig, eventId: string,
  slot: CardSlot, expectedId: string): Promise<boolean> {
  return withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active' || session[columns[slot]] !== expectedId ||
        session.identity_map.stickySuspended?.includes(slot)) return false;
    assertSessionConfig(session, config);
    const identity = session.identity_map;
    const stickySuspended = [...new Set([...(identity.stickySuspended ?? []), slot])];
    await client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
      [eventId, JSON.stringify({ ...identity, stickySuspended })]);
    return true;
  }));
}

export async function replaceStickyCard(config: PrivateDiscordConfig, eventId: string,
  slot: CardSlot, expectedId: string, newId: string): Promise<boolean> {
  if (!/^[1-9]\d{14,21}$/.test(newId)) throw new RuleError('Invalid Discord message ID.');
  return withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active') return false;
    assertSessionConfig(session, config);
    if (session[columns[slot]] !== expectedId || !session.identity_map.stickySuspended?.includes(slot)) return false;
    await client.query(`UPDATE public.tcg_rehearsal_sessions SET ${columns[slot]} = $2 WHERE event_id = $1`, [eventId, newId]);
    return true;
  }));
}

export async function completeStickyCard(config: PrivateDiscordConfig, eventId: string,
  slot: CardSlot, expectedId: string): Promise<void> {
  await withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active' || session[columns[slot]] !== expectedId) return;
    assertSessionConfig(session, config);
    const identity = session.identity_map;
    const stickySuspended = identity.stickySuspended?.filter(value => value !== slot) ?? [];
    await client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
      [eventId, JSON.stringify({ ...identity, stickySuspended })]);
  }));
}

export async function claimResumeReminder(config: PrivateDiscordConfig, eventId: string,
  matchId: MatchId, pauseGeneration: number): Promise<string[] | null> {
  return withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    const event = await client.query<{ state: EventState; version: number }>(
      'SELECT state,version FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!event.rows[0]) throw new RuleError('Unknown private Discord event.');
    verifyState(event.rows[0].state, eventId, event.rows[0].version);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active') throw new RuleError('Private Discord session is retired.');
    assertSessionConfig(session, config);
    const match = event.rows[0].state.matches.find(item => item.id === matchId);
    if (!match || match.phase !== 'paused' || match.pauseGeneration !== pauseGeneration ||
        match.resumeConsents.length !== 1 ||
        session.identity_map.resumeReminderGeneration?.[matchId] === pauseGeneration) return null;
    const waiting = match.players.filter(player => !match.resumeConsents.includes(player));
    if (waiting.length !== 1) return null;
    const identity = session.identity_map;
    await client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
      [eventId, JSON.stringify({ ...identity, resumeReminderGeneration: {
        ...identity.resumeReminderGeneration, [matchId]: pauseGeneration
      } })]);
    const players = resolvePlayers(session, event.rows[0].state);
    if (!players) return null;
    return [players[waiting[0]!]];
  }));
}
