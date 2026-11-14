import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_SIGNUP_CAPACITY, DEFAULT_TOURNAMENT_SWISS_RULES, isMatchId, type TournamentDetailsDto } from '@tcg-live/core';
import { createFixture, createSignupFixture, createTournamentFirstRound, RuleError, signupTournamentComplete, type EventState, type MatchId, type Player } from '../rehearsal/domain.js';
import { rehearsalClient, transaction, verifyState, withClient } from '../rehearsal/store.js';
import { publicConfig, sameIdentityMap, type ConfiguredRooms, type PrivateDiscordConfig } from './config.js';

export type CardSlot = 'checkin' | MatchId;
type SessionMetadata = { adminId: string; matchChannels?: ConfiguredRooms<string>;
  publicMatchRooms?: boolean;
  roundRooms?: Partial<Record<MatchId, string>>; matchMessages?: Partial<Record<MatchId, string>>; stickySuspended?: CardSlot[]; stickyPrevious?: Partial<Record<CardSlot, string[]>>; resumeReminderGeneration?: Partial<Record<MatchId, number>> };
export type SessionIdentity = SessionMetadata & (
  | { kind: 'signup'; players?: never }
  | { kind: 'legacy'; players: Record<Player, string> }
  | { kind?: undefined; players: Record<Player, string> }
);
export interface SessionRow {
  tournament?: TournamentDetailsDto;
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

const columns: Record<'checkin' | 'M1' | 'M2', 'checkin_message_id' | 'm1_message_id' | 'm2_message_id'> = {
  checkin: 'checkin_message_id', M1: 'm1_message_id', M2: 'm2_message_id'
};

export function sessionSlots(session: SessionRow): CardSlot[] {
  const extra = Object.keys(session.identity_map.matchMessages ?? {}).filter(isMatchId);
  return [...new Set<CardSlot>(['checkin', 'M1', 'M2', ...extra])];
}

function saveMessage(client: pg.Client, session: SessionRow, slot: CardSlot, id: string, identity: SessionIdentity) {
  if (slot === 'checkin' || slot === 'M1' || slot === 'M2') {
    return client.query(`UPDATE public.tcg_rehearsal_sessions SET ${columns[slot]} = $2, identity_map = $3::jsonb WHERE event_id = $1`,
      [session.event_id, id, JSON.stringify(identity)]);
  }
  return client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
    [session.event_id, JSON.stringify({ ...identity, matchMessages: { ...identity.matchMessages, [slot]: id } })]);
}

export function messageId(session: SessionRow, slot: CardSlot): string | null {
  return slot === 'checkin' || slot === 'M1' || slot === 'M2' ? session[columns[slot]] : session.identity_map.matchMessages?.[slot] ?? null;
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

export class NoActiveSessionError extends RuleError {}

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
    if (!session) throw new NoActiveSessionError('No active tournament. Open signup from Pending.');
    assertSessionConfig(session, config);
    const event = await client.query<{ state: EventState; version: number }>(
      'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1', [session.event_id]
    );
    if (!event.rows[0]) throw new RuleError('Private Discord event is missing.');
    verifyState(event.rows[0].state, session.event_id, event.rows[0].version);
    resolvePlayers(session, event.rows[0].state);
    // Older direct-bot installations may not have enabled the optional directory.
    const directory = await client.query<{ present: string | null }>("SELECT to_regclass('public.tcg_tournament_directory')::text AS present");
    if (directory.rows[0]?.present) {
      const metadata = await client.query<{ name: string; game: TournamentDetailsDto['game']; description: string | null; banner_style: string | null; starts_at_ms: string | null }>(
        "SELECT name, game, to_jsonb(d)->>'description' AS description, to_jsonb(d)->>'banner_style' AS banner_style, to_jsonb(d)->>'starts_at_ms' AS starts_at_ms FROM public.tcg_tournament_directory d WHERE id = $1", [session.event_id]);
      const details = metadata.rows[0];
      if (details) session.tournament = { eventId: session.event_id, name: details.name, game: details.game,
        description: details.description ?? '', configured: true,
        ...(details.starts_at_ms != null ? { startsAtMs: Number(details.starts_at_ms) } : {}),
        ...(details.banner_style === 'compact' ? { bannerStyle: 'compact' as const } : {}) };
    }
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

/** Finds scheduled signups that can use the configured Discord rooms without interrupting a tournament. */
export async function dueSignupDrafts(now: number): Promise<Array<{ eventId: string; activeId: string | null }>> {
  return withClient(async client => {
    const result = await client.query<{ event_id: string; active_id: string | null }>(`
      SELECT draft.id::text AS event_id, active.event_id::text AS active_id
      FROM public.tcg_tournament_directory draft
      LEFT JOIN public.tcg_rehearsal_sessions active ON active.status = 'active'
      LEFT JOIN public.tcg_rehearsal_events current_event ON current_event.id = active.event_id
      LEFT JOIN public.tcg_tournament_directory current_details ON current_details.id = active.event_id
      WHERE NOT draft.is_template AND draft.signup_opens_at_ms <= $1
        AND NOT EXISTS (SELECT 1 FROM public.tcg_rehearsal_sessions used WHERE used.event_id = draft.id)
        AND (active.event_id IS NULL OR
          (current_event.state->'signup' IS NOT NULL AND (
            (current_event.state->>'published' = 'true' AND
              jsonb_array_length(current_event.state->'matches') > 0 AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(current_event.state->'matches') AS match WHERE match->>'phase' <> 'final'))
            OR (current_details.id IS NULL AND current_event.state->'signup'->>'status' = 'open'
              AND current_event.state->'signup'->'roster' = '[]'::jsonb))))
      ORDER BY draft.signup_opens_at_ms, draft.created_at_ms, draft.id LIMIT 10`, [now]);
    return result.rows.map(row => ({ eventId: row.event_id, activeId: row.active_id }));
  });
}

/** Switches the event behind the configured Discord channels under the runtime's existing lease. */
export async function activateSignupDraft(config: PrivateDiscordConfig, eventId: string,
  expectedActiveEventId: string | null, ownsRuntime: () => boolean,
  prepareChannel?: (channelId: string) => Promise<() => (id: string, slot: CardSlot) => Promise<void>>,
  scheduled = false) {
  if (config.mode !== 'signup') throw new RuleError('Open signup from a runtime configured for signup tournaments.');
  return withClient(client => transaction(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_live_signup_activation'))");
    if (!ownsRuntime()) throw new RuleError('The bot is unavailable. Retry when Discord reconnects.');
    const { rows: [draft] } = await client.query<{ game: NonNullable<TournamentDetailsDto['game']>; match_minutes: number; signup_channel_id: string | null; signup_capacity: number | null; starts_at_ms: string | null; signup_opens_at_ms: string | null; is_template: boolean; swiss_rules: { byePoints?: number } | null }>(
      'SELECT game, match_minutes, signup_channel_id, signup_capacity, starts_at_ms, signup_opens_at_ms, is_template, swiss_rules FROM public.tcg_tournament_directory WHERE id = $1 FOR UPDATE', [eventId]);
    if (!draft) throw new RuleError('This draft no longer exists.');
    if (draft.is_template) throw new RuleError('Create a tournament from this template before opening signup.');
    if (draft.signup_opens_at_ms != null && Number(draft.signup_opens_at_ms) > Date.now())
      throw new RuleError('This tournament’s scheduled signup time has not arrived.');
    const { rows: [active] } = await client.query<SessionRow>("SELECT * FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
    if (active) assertSessionConfig(active, config);
    if (active?.event_id === eventId) return { game: draft.game, channelId: active.channel_id, retiredCards: [] };
    if ((active?.event_id ?? null) !== expectedActiveEventId)
      throw new RuleError('The active tournament changed. Return to the draft and review the current event.');
    const existing = await client.query('SELECT 1 FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    if (existing.rows.length) throw new RuleError('This tournament already ran. Create a new draft.');
    const channelId = draft.signup_channel_id ?? config.channelId;
    const moved = channelId !== config.channelId;
    if (moved && !prepareChannel) throw new RuleError('This bot cannot change signup channels.');
    const installChannel = moved ? await prepareChannel?.(channelId) : undefined;
    let completed = false;
    if (active) {
      // Gameplay commands lock this row before checking the session status.
      const { rows: [old] } = await client.query<{ state: EventState; version: number }>(
        'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [active.event_id]);
      if (!old) throw new RuleError('The current tournament could not be loaded.');
      verifyState(old.state, active.event_id, old.version);
      completed = signupTournamentComplete(old.state);
      if (scheduled && !completed) {
        const details = await client.query('SELECT 1 FROM public.tcg_tournament_directory WHERE id = $1', [active.event_id]);
        const emptySetup = !details.rowCount && old.state.signup?.status === 'open' && old.state.signup.roster.length === 0;
        if (!emptySetup) throw new RuleError('Scheduled signup is waiting for the active tournament to finish.');
      }
      if (old.state.published && old.state.matches.some(match => match.phase !== 'final'))
        throw new RuleError('Finish the current round before opening a new tournament.');
    }
    if (!ownsRuntime()) throw new RuleError('The bot is unavailable. Retry when Discord reconnects.');
    const reusable = (slot: CardSlot) => !completed && slot === 'checkin' && !moved;
    const stickyPrevious = Object.fromEntries(Object.entries(active?.identity_map.stickyPrevious ?? {})
      .filter(([slot]) => reusable(slot as CardSlot)));
    const retiredCards: Array<{ id: string; slot: CardSlot; channelId: string }> = [];
    if (active && !completed) for (const slot of sessionSlots(active)) {
      const id = messageId(active, slot);
      if (!reusable(slot) && id) retiredCards.push({ id, slot, channelId: slot === 'checkin' ? active.channel_id :
        active.identity_map.roundRooms?.[slot] ?? active.identity_map.matchChannels?.[slot] ?? active.channel_id });
    }
    const now = Date.now();
    const event = createTournamentFirstRound(eventId, draft.match_minutes * 60_000, draft.signup_capacity ?? DEFAULT_SIGNUP_CAPACITY,
      draft.swiss_rules?.byePoints ?? DEFAULT_TOURNAMENT_SWISS_RULES.byePoints);
    if (draft.starts_at_ms != null) event.startsAtMs = Number(draft.starts_at_ms);
    if (active) await client.query(
      "UPDATE public.tcg_rehearsal_sessions SET status = 'retired', retired_at_ms = $2, checkin_message_id = NULL, m1_message_id = NULL, m2_message_id = NULL WHERE event_id = $1",
      [active.event_id, now]);
    await client.query('INSERT INTO public.tcg_rehearsal_events (id, version, state) VALUES ($1,$2,$3::jsonb)',
      [event.id, event.version, JSON.stringify(event)]);
    await client.query(`INSERT INTO public.tcg_rehearsal_sessions
      (event_id,application_id,guild_id,channel_id,identity_map,status,created_at_ms,checkin_message_id,m1_message_id,m2_message_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6,$7,$8,$9)`, [
      event.id, config.applicationId, config.guildId, channelId,
      JSON.stringify({ kind: 'signup', adminId: config.adminId, matchChannels: config.matchChannels,
        publicMatchRooms: config.publicMatchRooms,
        stickyPrevious: Object.keys(stickyPrevious).length ? stickyPrevious : undefined, stickySuspended: active?.identity_map.stickySuspended?.filter(reusable) }),
      now, reusable('checkin') ? active?.checkin_message_id ?? null : null,
      reusable('M1') ? active?.m1_message_id ?? null : null, reusable('M2') ? active?.m2_message_id ?? null : null
    ]);
    if (!ownsRuntime()) throw new RuleError('The bot is unavailable. Retry when Discord reconnects.');
    return { game: draft.game, channelId, retiredCards, installChannel };
  }));
}

export async function deleteActiveTournament(config: PrivateDiscordConfig, eventId: string,
  ownsRuntime: () => boolean): Promise<SessionRow> {
  return withClient(client => transaction(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_live_signup_activation'))");
    if (!ownsRuntime()) throw new RuleError('The bot is unavailable. Retry when Discord reconnects.');
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const { rows: [session] } = await client.query<SessionRow & { deleted_at_ms: string | null }>(
      'SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    if (!session || (session.status !== 'active' && session.deleted_at_ms == null))
      throw new RuleError('This tournament is no longer active.');
    assertSessionConfig(session, config);
    if (session.deleted_at_ms != null) return session;
    if (!ownsRuntime()) throw new RuleError('The bot is unavailable. Retry when Discord reconnects.');
    await client.query("UPDATE public.tcg_rehearsal_sessions SET status = 'retired', retired_at_ms = $2, deleted_at_ms = $2 WHERE event_id = $1",
      [eventId, Date.now()]);
    return session;
  }));
}

export async function deletedSessionsWithCards(config: PrivateDiscordConfig): Promise<SessionRow[]> {
  return withClient(async client => {
    const result = await client.query<SessionRow>(`SELECT s.* FROM public.tcg_rehearsal_sessions s
      WHERE s.application_id = $1 AND s.guild_id = $2 AND s.status = 'retired'
        AND to_jsonb(s)->>'deleted_at_ms' IS NOT NULL
        AND (s.checkin_message_id IS NOT NULL OR s.m1_message_id IS NOT NULL OR s.m2_message_id IS NOT NULL
          OR s.identity_map ? 'stickyPrevious' OR s.identity_map ? 'matchMessages')`, [config.applicationId, config.guildId]);
    return result.rows;
  });
}

export async function clearDeletedSessionCards(eventId: string): Promise<void> {
  await withClient(async client => {
    await client.query(`UPDATE public.tcg_rehearsal_sessions SET checkin_message_id = NULL,
      m1_message_id = NULL, m2_message_id = NULL, identity_map = identity_map - 'stickyPrevious' - 'matchMessages'
      WHERE event_id = $1 AND status = 'retired' AND deleted_at_ms IS NOT NULL`, [eventId]);
  });
}

export async function bindRoundRoom(config: PrivateDiscordConfig, eventId: string, matchId: MatchId, roomId: string): Promise<void> {
  await withClient(client => transaction(client, async () => {
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const { rows: [session] } = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    if (!session || session.status !== 'active') throw new RuleError('Tournament room binding is no longer active.');
    assertSessionConfig(session, config);
    const identity = session.identity_map;
    const roundRooms = { ...identity.roundRooms, [matchId]: roomId };
    await client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
      [eventId, JSON.stringify({ ...identity, roundRooms })]);
  }));
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
    await saveMessage(client, row.rows[0], slot, id, { ...identity, stickySuspended });
  }));
}

export async function suspendStickyCard(config: PrivateDiscordConfig, eventId: string,
  slot: CardSlot, expectedId: string): Promise<boolean> {
  return withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active' || messageId(session, slot) !== expectedId ||
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
    if (messageId(session, slot) !== expectedId || !session.identity_map.stickySuspended?.includes(slot)) return false;
    const previous = session.identity_map.stickyPrevious ?? {};
    const stickyPrevious = { ...previous, [slot]: [...new Set([...(previous[slot] ?? []), expectedId])] };
    await saveMessage(client, session, slot, newId, { ...session.identity_map, stickyPrevious });
    return true;
  }));
}

export async function completeStickyCard(config: PrivateDiscordConfig, eventId: string,
  slot: CardSlot, expectedId: string, removedId: string): Promise<void> {
  await withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]);
    const row = await client.query<SessionRow>('SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
    const session = row.rows[0];
    if (!session || session.status !== 'active' || messageId(session, slot) !== expectedId) return;
    assertSessionConfig(session, config);
    const identity = session.identity_map;
    const stickySuspended = identity.stickySuspended?.filter(value => value !== slot) ?? [];
    const stickyPrevious = { ...identity.stickyPrevious };
    const outstanding = stickyPrevious[slot]?.filter(id => id !== removedId) ?? [];
    if (outstanding.length) stickyPrevious[slot] = outstanding;
    else delete stickyPrevious[slot];
    await client.query('UPDATE public.tcg_rehearsal_sessions SET identity_map = $2::jsonb WHERE event_id = $1',
      [eventId, JSON.stringify({ ...identity, stickySuspended,
        stickyPrevious: Object.keys(stickyPrevious).length ? stickyPrevious : undefined })]);
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
    return [players[waiting[0]!]!];
  }));
}
