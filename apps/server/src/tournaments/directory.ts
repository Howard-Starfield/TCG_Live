import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { ARTWORK_GAMES, DEFAULT_MATCH_MINUTES, MAX_MATCH_MINUTES, type ArtworkGame, type CreateTournamentDraftDto, type TournamentDetailsDto, type SaveTournamentDetailsDto,
  type SignupBannerStyle, type TournamentDirectoryDto, type TournamentDirectoryEntryDto } from '@tcg-live/core';
import { RuleError } from '../rehearsal/domain.js';
import { transaction, withClient } from '../rehearsal/store.js';
import { requireDiscordSchema } from '../discord/session.js';

const games = new Set<string>(ARTWORK_GAMES);
const labels: Record<ArtworkGame, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_CHARS = 120;
const MAX_QUERY_WORDS = 12;

export class DirectoryInputError extends Error {}
export class DirectoryConflictError extends RuleError {}
export class DirectoryUnavailableError extends RuleError {}

export interface TournamentDirectory {
  list(query: string, defaultGame: ArtworkGame): Promise<TournamentDirectoryDto>;
  createDraft(input: unknown): Promise<TournamentDirectoryEntryDto>;
  getDetails?(eventId: string): Promise<TournamentDetailsDto>;
  saveDetails?(eventId: string, input: unknown): Promise<TournamentDetailsDto>;
}

export function parseDetails(eventId: string, input: unknown): SaveTournamentDetailsDto {
  if (!UUID.test(eventId)) throw new DirectoryInputError('Choose a valid event ID.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DirectoryInputError('Tournament details must be an object.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['name', 'game', 'description', 'bannerStyle'].includes(key))) throw new DirectoryInputError('Tournament details contain unknown fields.');
  if (typeof value.name !== 'string' || !value.name.trim()) throw new DirectoryInputError('Tournament title is required.');
  if (typeof value.description !== 'string') throw new DirectoryInputError('Description must be text.');
  const { name, game, description, bannerStyle } = parseDraft({
    draftId: eventId, name: value.name, game: value.game, description: value.description, bannerStyle: value.bannerStyle
  });
  return { name, game, description, ...(value.bannerStyle !== undefined ? { bannerStyle } : {}) };
}

/** Search lexemes are alphanumeric before reaching to_tsquery; punctuation cannot become query syntax. */
export function searchQuery(input: string): string | null {
  if (input.length > MAX_QUERY_CHARS) throw new DirectoryInputError('Search is limited to 120 characters.');
  const words = input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) {
    if (input.trim()) throw new DirectoryInputError('Search must contain a word or number.');
    return null;
  }
  if (words.length > MAX_QUERY_WORDS) throw new DirectoryInputError('Search is limited to 12 words.');
  return words.map(word => `${word}:*`).join(' & ');
}

export function parseDraft(input: unknown): Required<Omit<CreateTournamentDraftDto, 'signupChannelId'>> & Pick<CreateTournamentDraftDto, 'signupChannelId'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DirectoryInputError('Draft details must be an object.');
  const draft = input as Record<string, unknown>;
  if (Object.keys(draft).some(key => !['draftId', 'name', 'game', 'description', 'matchMinutes', 'bannerStyle', 'signupChannelId'].includes(key)))
    throw new DirectoryInputError('Draft details contain unknown fields.');
  if (typeof draft.draftId !== 'string' || !UUID.test(draft.draftId)) throw new DirectoryInputError('Choose a valid draft ID.');
  if (typeof draft.game !== 'string' || !games.has(draft.game)) throw new DirectoryInputError('Choose a supported game.');
  const game = draft.game as ArtworkGame;
  if (draft.name !== undefined && typeof draft.name !== 'string') throw new DirectoryInputError('Tournament name must be text.');
  const name = typeof draft.name === 'string' ? draft.name.trim() : `${labels[game]} Tournament`;
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new DirectoryInputError('Tournament name must be 1–80 readable characters.');
  const description = draft.description === undefined ? '' : draft.description;
  if (typeof description !== 'string' || [...description].length > 500 ||
      /[\p{Cf}\p{Cc}]/u.test(description.replace(/\r?\n/g, '')))
    throw new DirectoryInputError('Description must be at most 500 readable characters.');
  const matchMinutes = draft.matchMinutes === undefined ? DEFAULT_MATCH_MINUTES : draft.matchMinutes;
  if (typeof matchMinutes !== 'number' || !Number.isInteger(matchMinutes) ||
      matchMinutes < 1 || matchMinutes > MAX_MATCH_MINUTES)
    throw new DirectoryInputError(`Match timer must be 1–${MAX_MATCH_MINUTES} whole minutes.`);
  const bannerStyle = draft.bannerStyle === undefined ? 'game' : draft.bannerStyle;
  if (bannerStyle !== 'game' && bannerStyle !== 'compact') throw new DirectoryInputError('Choose a signup banner style.');
  const signupChannelId = draft.signupChannelId;
  if (signupChannelId !== undefined && (typeof signupChannelId !== 'string' || !/^[1-9]\d{14,21}$/.test(signupChannelId)))
    throw new DirectoryInputError('Choose a valid Discord signup channel.');
  return { draftId: draft.draftId.toLowerCase(), game, name, description: description.trim(), matchMinutes, bannerStyle,
    ...(signupChannelId ? { signupChannelId } : {}) };
}

function searchText(name: string, game: ArtworkGame): string {
  const normalized = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const gameWords = `${game} ${game.replaceAll('-', '')} ${labels[game]}`.normalize('NFD')
    .replace(/\p{M}/gu, '').toLowerCase();
  return `${normalized} ${gameWords} signup tournament`;
}

export async function requireDirectorySchema(client: pg.Client): Promise<void> {
  await requireDiscordSchema(client);
  const result = await client.query<{ present: string | null }>(
    "SELECT to_regclass('public.tcg_tournament_directory')::text AS present");
  if (!result.rows[0]?.present) throw new DirectoryUnavailableError(
    'Tournament directory is not set up. Run npm run db:directory-setup -w @tcg-live/server.');
}

interface DirectoryRow {
  event_id: string; name: string | null; game: ArtworkGame | null;
  status: 'active' | 'retired' | null; kind: string | null;
  description: string | null; match_minutes: number | null; banner_style: SignupBannerStyle | null; signup_channel_id: string | null;
  created_at_ms: number; retired_at_ms: number | null;
}
function entry(row: DirectoryRow): TournamentDirectoryEntryDto {
  const kind = row.kind === 'signup' || (!row.status && row.name) ? 'signup' : 'legacy';
  return { eventId: row.event_id,
    name: row.name ?? (kind === 'signup' ? 'Signup tournament' : 'Practice tournament'),
    game: row.game, ...(row.description !== null ? { description: row.description } : {}),
    ...(row.match_minutes !== null ? { matchMinutes: row.match_minutes } : {}),
    ...(row.banner_style !== null ? { bannerStyle: row.banner_style } : {}),
    ...(row.signup_channel_id ? { signupChannelId: row.signup_channel_id } : {}), status: row.status ?? 'draft', kind,
    createdAtMs: Number(row.created_at_ms), retiredAtMs: row.retired_at_ms === null ? null : Number(row.retired_at_ms) };
}

export function pgTournamentDirectory(canWrite: () => boolean = () => false,
  now: () => number = Date.now): TournamentDirectory {
  return {
    async getDetails(eventId) {
      if (!UUID.test(eventId)) throw new DirectoryInputError('Choose a valid event ID.');
      return withClient(async client => {
        await requireDirectorySchema(client);
        const result = await client.query<{ name: string | null; game: ArtworkGame | null; description: string | null; banner_style: SignupBannerStyle | null }>(
          `SELECT d.name, d.game, d.description, d.banner_style
           FROM public.tcg_rehearsal_sessions s LEFT JOIN public.tcg_tournament_directory d ON d.id = s.event_id
           WHERE s.event_id = $1`, [eventId]);
        const row = result.rows[0];
        if (!row) throw new DirectoryConflictError('This tournament session does not exist.');
        return { eventId, name: row.name ?? 'Signup tournament', game: row.game,
          description: row.description ?? '', bannerStyle: row.banner_style ?? 'game', configured: row.name !== null };
      });
    },
    async saveDetails(eventId, input) {
      const value = parseDetails(eventId, input);
      if (!canWrite()) throw new DirectoryUnavailableError('The active bot no longer owns tournament changes.');
      return withClient(client => transaction(client, async () => {
        await requireDirectorySchema(client);
        const sessions = await client.query<{ status: string; created_at_ms: string }>(
          'SELECT status, created_at_ms FROM public.tcg_rehearsal_sessions WHERE event_id = $1 FOR UPDATE', [eventId]);
        const session = sessions.rows[0];
        if (!session || session.status !== 'active') throw new DirectoryConflictError('Only the active tournament can be edited.');
        if (!canWrite()) throw new DirectoryUnavailableError('The active bot no longer owns tournament changes.');
        const updated = await client.query<{ banner_style: SignupBannerStyle }>(`INSERT INTO public.tcg_tournament_directory
          (id, name, game, description, created_at_ms, search_text, banner_style)
          VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'game')) ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, game = EXCLUDED.game, description = EXCLUDED.description, search_text = EXCLUDED.search_text,
          banner_style = COALESCE($7, tcg_tournament_directory.banner_style) RETURNING banner_style`,
        [eventId, value.name, value.game, value.description, session.created_at_ms, searchText(value.name, value.game), value.bannerStyle ?? null]);
        return { eventId, ...value, bannerStyle: updated.rows[0]!.banner_style, configured: true };
      }));
    },
    async list(query, defaultGame) {
      const tsquery = searchQuery(query);
      const entries = await withClient(async client => {
        await requireDirectorySchema(client);
        const result = await client.query<DirectoryRow>(
          `WITH hits AS (
             SELECT d.id::text AS event_id, d.name, d.game, d.description, d.match_minutes, d.banner_style, d.signup_channel_id, NULL::text AS status,
               'signup'::text AS kind, d.created_at_ms::float8 AS created_at_ms,
               NULL::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory d
             WHERE NOT EXISTS (SELECT 1 FROM public.tcg_rehearsal_sessions s WHERE s.event_id = d.id)
               AND ($1::text IS NULL OR d.search_vector @@ to_tsquery('simple', $1))
             UNION ALL
             SELECT s.event_id::text AS event_id, d.name, d.game, d.description, d.match_minutes, d.banner_style, s.channel_id AS signup_channel_id, s.status,
               s.identity_map->>'kind' AS kind,
               COALESCE(d.created_at_ms, s.created_at_ms)::float8 AS created_at_ms,
               s.retired_at_ms::float8 AS retired_at_ms
             FROM public.tcg_rehearsal_sessions s
             LEFT JOIN public.tcg_tournament_directory d ON d.id = s.event_id
             WHERE $1::text IS NULL OR
               to_tsvector('simple', COALESCE(d.search_text,
                 CASE WHEN s.identity_map->>'kind' = 'signup' THEN 'signup tournament'
                      ELSE 'practice tournament' END) || ' ' || s.status || ' ' ||
                 COALESCE(s.identity_map->>'kind', 'legacy')) @@ to_tsquery('simple', $1)
           )
           SELECT * FROM hits ORDER BY created_at_ms DESC, event_id DESC`, [tsquery]);
        return result.rows.map(entry);
      });
      return { entries, defaultGame };
    },
    async createDraft(input) {
      const draft = parseDraft(input);
      if (!canWrite()) throw new DirectoryUnavailableError('The active bot no longer owns tournament changes.');
      return withClient(async client => {
        await requireDirectorySchema(client);
        return transaction(client, async () => {
          if (!canWrite()) throw new DirectoryUnavailableError('The active bot no longer owns tournament changes.');
          const existing = await client.query<DirectoryRow>(
            `SELECT d.id::text AS event_id, d.name, d.game, d.description, d.match_minutes, d.banner_style, d.signup_channel_id, s.status, s.identity_map->>'kind' AS kind,
               d.created_at_ms::float8 AS created_at_ms, s.retired_at_ms::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory d
             LEFT JOIN public.tcg_rehearsal_sessions s ON s.event_id = d.id WHERE d.id = $1 FOR UPDATE OF d`,
            [draft.draftId]);
          if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.name !== draft.name || row.game !== draft.game ||
                row.description !== draft.description || row.match_minutes !== draft.matchMinutes || row.banner_style !== draft.bannerStyle || row.signup_channel_id !== (draft.signupChannelId ?? null) || row.status !== null)
              throw new DirectoryConflictError('This draft ID already belongs to a different tournament.');
            return entry(row);
          }
          const session = await client.query('SELECT 1 FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [draft.draftId]);
          if (session.rows.length) throw new DirectoryConflictError('This draft ID already belongs to an event.');
          const createdAtMs = now();
          const inserted = await client.query<DirectoryRow>(
            `INSERT INTO public.tcg_tournament_directory (id, name, game, created_at_ms, search_text, description, match_minutes, banner_style, signup_channel_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO NOTHING
             RETURNING id::text AS event_id, name, game, description, match_minutes, banner_style, signup_channel_id, NULL::text AS status, 'signup'::text AS kind,
               created_at_ms::float8 AS created_at_ms, NULL::float8 AS retired_at_ms`,
            [draft.draftId, draft.name, draft.game, createdAtMs, searchText(draft.name, draft.game), draft.description, draft.matchMinutes, draft.bannerStyle, draft.signupChannelId ?? null]);
          if (inserted.rows[0]) return entry(inserted.rows[0]);
          const raced = await client.query<DirectoryRow>(
            `SELECT id::text AS event_id, name, game, description, match_minutes, banner_style, signup_channel_id, NULL::text AS status, 'signup'::text AS kind,
               created_at_ms::float8 AS created_at_ms, NULL::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory WHERE id = $1`, [draft.draftId]);
          const row = raced.rows[0];
          if (!row || row.name !== draft.name || row.game !== draft.game ||
                row.description !== draft.description || row.match_minutes !== draft.matchMinutes || row.banner_style !== draft.bannerStyle || row.signup_channel_id !== (draft.signupChannelId ?? null))
            throw new DirectoryConflictError('This draft ID already belongs to a different tournament.');
          return entry(row);
        });
      });
    }
  };
}

/** Explicit additive migration; never changes the required Discord schema version or event rows. */
export async function setupTournamentDirectory(): Promise<'created' | 'already_ready'> {
  return withClient(client => transaction(client, async () => {
    await requireDiscordSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_tournament_directory_schema'))");
    const objects = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname");
    const names = objects.rows.map(row => row.relname).join(',');
    const base = 'tcg_rehearsal_audit,tcg_rehearsal_events,tcg_rehearsal_meta,tcg_rehearsal_sessions';
    const exists = names === `${base},tcg_tournament_directory`;
    if (!exists && names !== base) throw new DirectoryUnavailableError('Tournament directory setup refused: unexpected public schema.');
    const migrations = ['003_tournament_directory.sql', '004_tournament_description.sql', '005_tournament_match_timer.sql', '006_tournament_signup_banner.sql'];
    for (const file of exists ? migrations.slice(1) : migrations) {
      await client.query(await readFile(new URL(`../../../../database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    return exists ? 'already_ready' : 'created';
  }));
}
