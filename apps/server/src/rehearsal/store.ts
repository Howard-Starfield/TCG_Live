import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { parseDatabaseUrl } from '../config.js';
import { createFixture, type Command, type EventState, type Outcome, RuleError, transition } from './domain.js';
import { channelForSlot, sameIdentityMap, type PrivateDiscordConfig } from '../discord/config.js';
import { resolvePlayers, type CardSlot, type SessionRow } from '../discord/session.js';

const DB_ERROR = 'Rehearsal database operation failed.';
const TARGET_DB = 'tcg_rehearsal';
const TABLES_V1 = ['tcg_rehearsal_audit', 'tcg_rehearsal_events', 'tcg_rehearsal_meta'];
const TABLES_V2 = [...TABLES_V1, 'tcg_rehearsal_sessions'];

export interface AuditRow {
  sequence: number;
  command_id: string;
  actor_id: string;
  action: Command;
  outcome: Outcome;
  occurred_at_ms: number;
  mode: string | null;
}

function validatedDatabase() {
  const database = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!database) throw new RuleError('DATABASE_URL is required for rehearsal commands.');
  if (database.database !== TARGET_DB) throw new RuleError('Rehearsal commands require the exact tcg_rehearsal database.');
  return database;
}

export function rehearsalClient(): pg.Client {
  const database = validatedDatabase();
  return new pg.Client({
    ...database,
    ssl: false,
    sslnegotiation: 'postgres',
    options: '-c statement_timeout=2000',
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_500,
    statement_timeout: 2_000,
    application_name: 'tcg_live_rehearsal'
  } as pg.ClientConfig & { sslnegotiation: string });
}

export async function verifyTarget(client: pg.Client): Promise<void> {
  const db = await client.query<{ name: string }>('SELECT current_database() AS name');
  if (db.rows[0]?.name !== TARGET_DB) throw new RuleError('Rehearsal commands require the exact tcg_rehearsal database.');
  const marker = await client.query<{ value: string }>(
    "SELECT value FROM public.tcg_rehearsal_meta WHERE key = 'schema_version'"
  );
  if (marker.rows.length !== 1 || !['1', '2'].includes(marker.rows[0]?.value ?? '')) {
    throw new RuleError('Rehearsal schema version is incompatible.');
  }
}

export function verifyState(state: EventState, id: string, version: number): void {
  const signup = state.signup;
  const signupValid = signup && Array.isArray(signup.roster) && signup.roster.length <= 4 &&
    new Set(signup.roster).size === signup.roster.length &&
    signup.roster.every(member => typeof member === 'string' && /^[1-9]\d{14,21}$/.test(member)) &&
    (signup.status === 'open' ? !signup.assignment : signup.status === 'assigned' &&
      signup.roster.length === 4 && !!signup.assignment &&
      Object.keys(signup.assignment).sort().join(',') === 'A,B,C,D' &&
      (['A', 'B', 'C', 'D'] as const).every((player, index) => signup.assignment?.[player] === signup.roster[index]));
  if (!((state.schemaVersion === 1 && !signup) || (state.schemaVersion === 2 && signupValid)) ||
      state.id !== id || state.version !== version) {
    throw new RuleError('Rehearsal aggregate schema version is incompatible.');
  }
}

export async function withClient<T>(operation: (client: pg.Client) => Promise<T>, requireSchema = true): Promise<T> {
  const client = rehearsalClient();
  client.on('error', () => {});
  let cleanupTimer: NodeJS.Timeout | undefined;
  try {
    await client.connect();
    if (requireSchema) await verifyTarget(client);
    return await operation(client);
  } catch (error) {
    if (error instanceof RuleError) throw error;
    throw new Error(DB_ERROR);
  } finally {
    await Promise.race([
      client.end().catch(() => {}),
      new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2_000); })
    ]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    const connection = client as pg.Client & { connection?: { stream?: { destroy(): void } } };
    connection.connection?.stream?.destroy();
  }
}

export async function transaction<T>(client: pg.Client, operation: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Original error decides the outcome. */ }
    throw error;
  }
}

export async function setupRehearsalSchema(): Promise<'created' | 'already_ready'> {
  const selected = validatedDatabase();
  if (selected.database !== TARGET_DB) throw new RuleError('Schema setup requires the exact tcg_rehearsal database.');
  return withClient(client => transaction(client, async () => {
    const db = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (db.rows[0]?.name !== TARGET_DB) throw new RuleError('Schema setup requires the exact tcg_rehearsal database.');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_rehearsal_schema'))");
    const objects = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname"
    );
    const names = objects.rows.map(row => row.relname);
    if (names.length === 0) {
      const sql = await readFile(new URL('../../../../database/migrations/001_rehearsal.sql', import.meta.url), 'utf8');
      await client.query(sql);
      return 'created';
    }
    if (JSON.stringify(names) !== JSON.stringify(TABLES_V1) && JSON.stringify(names) !== JSON.stringify(TABLES_V2)) {
      throw new RuleError('Schema setup refused: public schema is not the expected rehearsal fixture.');
    }
    const marker = await client.query<{ value: string }>(
      "SELECT value FROM public.tcg_rehearsal_meta WHERE key = 'schema_version'"
    );
    if (marker.rows.length !== 1 ||
        (JSON.stringify(names) === JSON.stringify(TABLES_V1) && marker.rows[0]?.value !== '1') ||
        (JSON.stringify(names) === JSON.stringify(TABLES_V2) && marker.rows[0]?.value !== '2')) {
      throw new RuleError('Schema setup refused: rehearsal schema version is incompatible.');
    }
    return 'already_ready';
  }), false);
}

export async function setupPrivateDiscordSchema(): Promise<'upgraded' | 'already_ready'> {
  return withClient(client => transaction(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_rehearsal_schema'))");
    const objects = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname"
    );
    const names = objects.rows.map(row => row.relname);
    const marker = await client.query<{ value: string }>(
      "SELECT value FROM public.tcg_rehearsal_meta WHERE key = 'schema_version'"
    );
    if (JSON.stringify(names) === JSON.stringify(TABLES_V2) && marker.rows[0]?.value === '2') return 'already_ready';
    if (JSON.stringify(names) !== JSON.stringify(TABLES_V1) || marker.rows[0]?.value !== '1') {
      throw new RuleError('Private Discord migration refused: unexpected rehearsal schema.');
    }
    const sql = await readFile(new URL('../../../../database/migrations/002_private_discord.sql', import.meta.url), 'utf8');
    await client.query(sql);
    return 'upgraded';
  }));
}

export async function createRehearsalEvent(durationMs = 60_000): Promise<EventState> {
  const event = createFixture(randomUUID(), durationMs);
  return withClient(async client => {
    await client.query('INSERT INTO public.tcg_rehearsal_events (id, version, state) VALUES ($1, $2, $3::jsonb)',
      [event.id, event.version, JSON.stringify(event)]);
    return event;
  });
}

export async function getRehearsalEvent(eventId: string): Promise<EventState> {
  return withClient(async client => {
    const result = await client.query<{ state: EventState; version: number }>(
      'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1', [eventId]
    );
    if (!result.rows[0]) throw new RuleError('Unknown rehearsal event.');
    verifyState(result.rows[0].state, eventId, result.rows[0].version);
    return result.rows[0].state;
  });
}

export async function getRehearsalAudit(eventId: string): Promise<AuditRow[]> {
  return withClient(async client => {
    const result = await client.query<AuditRow>(
      'SELECT sequence, command_id, actor_id, action, outcome, occurred_at_ms::float8 AS occurred_at_ms, mode FROM public.tcg_rehearsal_audit WHERE event_id = $1 ORDER BY sequence',
      [eventId]
    );
    return result.rows;
  });
}

export async function countRehearsalEvents(): Promise<number> {
  return withClient(async client => {
    const result = await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM public.tcg_rehearsal_events');
    return result.rows[0]?.count ?? 0;
  });
}

export async function applyRehearsalCommand(
  eventId: string, commandId: string, actor: string, command: Command,
  runnerId: string, nowMs = Date.now()
): Promise<Outcome> {
  if (!commandId || commandId.length > 128) throw new RuleError('A command ID of at most 128 characters is required.');
  const hash = createHash('sha256').update(JSON.stringify([actor, command])).digest('hex');
  return withClient(client => transaction(client, async () => {
    const row = await client.query<{ state: EventState; version: number }>(
      'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [eventId]
    );
    if (!row.rows[0]) throw new RuleError('Unknown rehearsal event.');
    verifyState(row.rows[0].state, eventId, row.rows[0].version);
    const prior = await client.query<{ command_hash: string; outcome: Outcome }>(
      'SELECT command_hash, outcome FROM public.tcg_rehearsal_audit WHERE event_id = $1 AND command_id = $2',
      [eventId, commandId]
    );
    if (prior.rows[0]) {
      if (prior.rows[0].command_hash !== hash) throw new RuleError('Command ID conflicts with different content.');
      return prior.rows[0].outcome;
    }
    const result = transition(row.rows[0].state, actor, command, nowMs, runnerId);
    if (!result.outcome.applied) return result.outcome;
    await client.query('UPDATE public.tcg_rehearsal_events SET version = $2, state = $3::jsonb WHERE id = $1',
      [eventId, result.state.version, JSON.stringify(result.state)]);
    await client.query(
      'INSERT INTO public.tcg_rehearsal_audit (event_id, sequence, command_id, actor_id, command_hash, action, outcome, occurred_at_ms, mode) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)',
      [eventId, result.state.version, commandId, actor, hash, JSON.stringify(command), JSON.stringify(result.outcome), nowMs,
        'matchId' in command ? 'CAM' : null]
    );
    return result.outcome;
  }));
}

// Store refusals with a specific meaning for the admin console. Each extends RuleError and keeps the
// message the Discord path always replied with, so slash commands and buttons behave as before.
/** The event row (or, for a console principal, its session) does not exist. */
export class UnknownEventError extends RuleError {}
/** The event's session is retired: it is no longer the active event. */
export class RetiredSessionError extends RuleError {}
/** The command ID was stored before with different content. */
export class CommandConflictError extends RuleError {}
/** The state the console admin saw no longer matches the locked aggregate. */
export class PreconditionFailedError extends RuleError {}

const WEB_COMMAND_ID = /^web:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A console principal issues admin commands only, the same set as the /tcg-test admin subcommands. */
const WEB_COMMAND_TYPES: ReadonlySet<string> = new Set<Command['type']>(
  ['publish', 'signupClose', 'signupReopen', 'signupRemove', 'judgeResume', 'resolve', 'correct']);

export interface DiscordCommandContext {
  config: PrivateDiscordConfig;
  eventId: string;
  principalId: string;
  interactionId?: string;
  message?: { slot: CardSlot; id: string; channelId: string };
  timer?: { matchId: 'M1' | 'M2'; pauseGeneration: number; deadlineMs: number };
}

export interface WebCommandContext {
  config: PrivateDiscordConfig;
  eventId: string;
  /** The console principal, for example `local-admin`; stored as principal_id. */
  principalId: string;
  /** `web:<uuid v4>` from the browser. */
  commandId: string;
  /** Canonical request content (event, command, precondition). A reused command ID with other content conflicts. */
  content: string;
  /** The state the admin saw. Checked under the event's FOR UPDATE lock, after the prior-result lookup. */
  precondition(state: EventState): boolean;
}

/** One transaction body for every principal kind, so the Discord and console paths cannot drift. */
export type PrincipalCommandContext =
  | ({ kind: 'discord' } & DiscordCommandContext)
  | ({ kind: 'web' } & WebCommandContext);

type QueryClient = Pick<pg.Client, 'query'>;

/** The stored command ID and content hash. Validates identity before any connection is opened. */
function principalCommand(context: PrincipalCommandContext, command: Command): { commandId: string; hash: string } {
  if (context.kind === 'web') {
    if (!WEB_COMMAND_ID.test(context.commandId)) throw new RuleError('Invalid console command ID.');
    if (!WEB_COMMAND_TYPES.has(command.type)) throw new RuleError('Console principal action denied.');
    return { commandId: context.commandId,
      hash: createHash('sha256').update(JSON.stringify(['web', context.principalId, context.content])).digest('hex') };
  }
  if (!context.interactionId && !context.timer) throw new RuleError('Discord command identity is required.');
  if (context.timer && (command.type !== 'clockCheck' || command.matchId !== context.timer.matchId ||
      context.principalId !== 'system:timer')) throw new RuleError('Invalid timer command.');
  const commandId = context.timer
    ? `timer:${context.timer.matchId}:${context.timer.pauseGeneration}:${context.timer.deadlineMs}`
    : `discord:${context.interactionId}`;
  if (commandId.length > 128) throw new RuleError('Invalid Discord command ID.');
  return { commandId, hash: createHash('sha256').update(JSON.stringify([context.principalId, command])).digest('hex') };
}

/**
 * The transaction body, run inside BEGIN/COMMIT. Order: lock the event row (FOR UPDATE), then the
 * prior result for the command ID, then the session and precondition checks, then the domain apply.
 * A console command looks up its prior result before the session checks, so a retried success is
 * answered from the stored outcome even after the event changed or retired. The Discord order is the
 * historical one (prior result after the session, card and actor checks).
 */
export async function runPrincipalCommand(
  client: QueryClient, context: PrincipalCommandContext, command: Command, runnerId: string, clock: () => number
): Promise<Outcome> {
  const { commandId, hash } = principalCommand(context, command);
  const discord = context.kind === 'discord' ? context : null;
  const web = context.kind === 'web' ? context : null;
  const row = await client.query<{ state: EventState; version: number }>(
    'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1 FOR UPDATE', [context.eventId]
  );
  const event = row.rows[0];
  if (!event) throw new UnknownEventError(web ? 'Unknown event.' : 'Unknown private Discord event.');
  verifyState(event.state, context.eventId, event.version);
  const priorOutcome = async (): Promise<Outcome | null> => {
    if (web) {
      // Command IDs are browser UUIDs: one found under another event is a reuse with different content.
      const prior = await client.query<{ event_id: string; command_hash: string; outcome: Outcome }>(
        'SELECT event_id::text AS event_id, command_hash, outcome FROM public.tcg_rehearsal_audit WHERE command_id = $1',
        [commandId]
      );
      const found = prior.rows[0];
      if (!found) return null;
      if (found.event_id !== context.eventId || found.command_hash !== hash)
        throw new CommandConflictError('Command ID conflicts with different content.');
      return found.outcome;
    }
    const prior = await client.query<{ command_hash: string; outcome: Outcome }>(
      'SELECT command_hash, outcome FROM public.tcg_rehearsal_audit WHERE event_id = $1 AND command_id = $2',
      [context.eventId, commandId]
    );
    if (!prior.rows[0]) return null;
    if (prior.rows[0].command_hash !== hash) throw new CommandConflictError('Command ID conflicts with different content.');
    return prior.rows[0].outcome;
  };
  if (web) {
    const replay = await priorOutcome();
    if (replay) return replay;
  }
  const sessionRow = await client.query<SessionRow>(
    'SELECT * FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [context.eventId]
  );
  const session = sessionRow.rows[0];
  // A rehearsal CLI event has no session: the console never lists it, so it is unknown there.
  if (!session && web) throw new UnknownEventError('Unknown event.');
  if (!session || session.status !== 'active') throw new RetiredSessionError('Private Discord session is retired.');
  if (session.application_id !== context.config.applicationId ||
      session.guild_id !== context.config.guildId || session.channel_id !== context.config.channelId ||
      !sameIdentityMap(session.identity_map, context.config)) {
    throw new RuleError('Private Discord configuration differs from the saved session.');
  }
  const players = resolvePlayers(session, event.state);
  if (discord?.message) {
    const expectedSlot = ['checkin', 'signupJoin', 'signupWithdraw'].includes(command.type) ? 'checkin'
      : 'matchId' in command ? command.matchId : null;
    if (discord.message.slot !== expectedSlot) throw new RuleError('This control is on the wrong practice card.');
    if (discord.message.channelId !== channelForSlot(context.config, discord.message.slot))
      throw new RuleError('This control is in the wrong practice channel.');
    const field = discord.message.slot === 'checkin' ? session.checkin_message_id
      : discord.message.slot === 'M1' ? session.m1_message_id : session.m2_message_id;
    if (!field || field !== discord.message.id) throw new RuleError('This control is not on the canonical card.');
  }
  if (event.state.matches.some(match => match.phase === 'running' && match.runnerId !== runnerId)) {
    throw new RuleError('Private Discord session has an interrupted running clock; stop and prepare --replace.');
  }
  // A console principal is the configured admin (decision 4); timers act as the admin too.
  let actor = 'admin:fixture';
  if (discord && !discord.timer) {
    const player = (Object.entries(players ?? {}) as Array<['A' | 'B' | 'C' | 'D', string]>)
      .find(([, id]) => id === context.principalId)?.[0];
    if (context.principalId === session.identity_map.adminId) actor = 'admin:fixture';
    else if (command.type === 'signupJoin' || command.type === 'signupWithdraw') actor = `member:${context.principalId}`;
    else if (player) actor = `player:${player}`;
    else throw new RuleError('Discord actor is not in the private fixture.');
    if (player && !discord.message) throw new RuleError('Player action requires its canonical card.');
    if ((command.type === 'signupJoin' || command.type === 'signupWithdraw') && !discord.message)
      throw new RuleError('Signup action requires its canonical card.');
  }
  if ((web || (discord && !discord.timer)) && command.type === 'signupClose' && command.adminId !== session.identity_map.adminId)
    throw new RuleError('Signup admin identity differs from the saved session.');
  if (discord) {
    const replay = await priorOutcome();
    if (replay) return replay;
  }
  if (web && !web.precondition(event.state))
    throw new PreconditionFailedError('The event changed since this action was prepared; review the latest state.');
  const nowMs = clock();
  if (discord?.timer) {
    const timer = discord.timer;
    const match = event.state.matches.find(item => item.id === timer.matchId);
    const expected = match?.startedAtMs === null || !match ? null : match.startedAtMs + match.remainingMs;
    if (!match || match.phase !== 'running' || match.pauseGeneration !== timer.pauseGeneration ||
        expected !== timer.deadlineMs || nowMs < timer.deadlineMs) {
      return { eventId: context.eventId, version: event.version, result: 'obsolete_or_early_timer', applied: false };
    }
  }
  const result = transition(event.state, actor, command, nowMs, runnerId);
  if (!result.outcome.applied) return result.outcome;
  await client.query('UPDATE public.tcg_rehearsal_events SET version = $2, state = $3::jsonb WHERE id = $1',
    [context.eventId, result.state.version, JSON.stringify(result.state)]);
  await client.query(
    'INSERT INTO public.tcg_rehearsal_audit (event_id,sequence,command_id,actor_id,command_hash,action,outcome,occurred_at_ms,mode,principal_kind,principal_id,interaction_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)',
    [context.eventId, result.state.version, commandId, actor, hash, JSON.stringify(command),
      JSON.stringify(result.outcome), nowMs, 'matchId' in command ? 'CAM' : null,
      discord?.timer ? 'system' : context.kind, context.principalId, discord?.interactionId ?? null]
  );
  return result.outcome;
}

export async function applyPrincipalCommand(
  context: PrincipalCommandContext, command: Command, runnerId: string, clock: () => number = Date.now
): Promise<Outcome> {
  principalCommand(context, command);
  return withClient(client => transaction(client, () => runPrincipalCommand(client, context, command, runnerId, clock)));
}

/** Slash commands, buttons and timers. A thin wrapper over the shared transaction body. */
export async function applyDiscordCommand(
  context: DiscordCommandContext, command: Command, runnerId: string,
  clock: () => number = Date.now
): Promise<Outcome> {
  return applyPrincipalCommand({ ...context, kind: 'discord' }, command, runnerId, clock);
}

/** Admin console commands (principal_kind 'web'). A thin wrapper over the shared transaction body. */
export async function applyWebCommand(
  context: WebCommandContext, command: Command, runnerId: string, clock: () => number = Date.now
): Promise<Outcome> {
  return applyPrincipalCommand({ ...context, kind: 'web' }, command, runnerId, clock);
}

