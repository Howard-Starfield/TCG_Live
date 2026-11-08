import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { ARTWORK_GAMES, type ArtworkGame, type CreateTournamentDraftDto,
  type TournamentDirectoryDto, type TournamentDirectoryEntryDto } from '@tcg-live/core';
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

export function parseDraft(input: unknown): Required<CreateTournamentDraftDto> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DirectoryInputError('Draft details must be an object.');
  const draft = input as Record<string, unknown>;
  if (Object.keys(draft).some(key => !['draftId', 'name', 'game'].includes(key)))
    throw new DirectoryInputError('Draft details contain unknown fields.');
  if (typeof draft.draftId !== 'string' || !UUID.test(draft.draftId)) throw new DirectoryInputError('Choose a valid draft ID.');
  if (typeof draft.game !== 'string' || !games.has(draft.game)) throw new DirectoryInputError('Choose a supported game.');
  const game = draft.game as ArtworkGame;
  if (draft.name !== undefined && typeof draft.name !== 'string') throw new DirectoryInputError('Tournament name must be text.');
  const name = typeof draft.name === 'string' ? draft.name.trim() : `${labels[game]} Tournament`;
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new DirectoryInputError('Tournament name must be 1–80 readable characters.');
  return { draftId: draft.draftId.toLowerCase(), game, name };
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
  created_at_ms: number; retired_at_ms: number | null;
}
function entry(row: DirectoryRow): TournamentDirectoryEntryDto {
  const kind = row.kind === 'signup' || (!row.status && row.name) ? 'signup' : 'legacy';
  return { eventId: row.event_id,
    name: row.name ?? (kind === 'signup' ? 'Signup tournament' : 'Practice tournament'),
    game: row.game, status: row.status ?? 'draft', kind,
    createdAtMs: Number(row.created_at_ms), retiredAtMs: row.retired_at_ms === null ? null : Number(row.retired_at_ms) };
}

export function pgTournamentDirectory(canWrite: () => boolean = () => false,
  now: () => number = Date.now): TournamentDirectory {
  return {
    async list(query, defaultGame) {
      const tsquery = searchQuery(query);
      const entries = await withClient(async client => {
        await requireDirectorySchema(client);
        const result = await client.query<DirectoryRow>(
          `WITH hits AS (
             SELECT d.id::text AS event_id, d.name, d.game, NULL::text AS status,
               'signup'::text AS kind, d.created_at_ms::float8 AS created_at_ms,
               NULL::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory d
             WHERE NOT EXISTS (SELECT 1 FROM public.tcg_rehearsal_sessions s WHERE s.event_id = d.id)
               AND ($1::text IS NULL OR d.search_vector @@ to_tsquery('simple', $1))
             UNION ALL
             SELECT s.event_id::text AS event_id, d.name, d.game, s.status,
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
            `SELECT d.id::text AS event_id, d.name, d.game, s.status, s.identity_map->>'kind' AS kind,
               d.created_at_ms::float8 AS created_at_ms, s.retired_at_ms::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory d
             LEFT JOIN public.tcg_rehearsal_sessions s ON s.event_id = d.id WHERE d.id = $1 FOR UPDATE OF d`,
            [draft.draftId]);
          if (existing.rows[0]) {
            const row = existing.rows[0];
            if (row.name !== draft.name || row.game !== draft.game || row.status !== null)
              throw new DirectoryConflictError('This draft ID already belongs to a different tournament.');
            return entry(row);
          }
          const session = await client.query('SELECT 1 FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [draft.draftId]);
          if (session.rows.length) throw new DirectoryConflictError('This draft ID already belongs to an event.');
          const createdAtMs = now();
          const inserted = await client.query<DirectoryRow>(
            `INSERT INTO public.tcg_tournament_directory (id, name, game, created_at_ms, search_text)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING
             RETURNING id::text AS event_id, name, game, NULL::text AS status, 'signup'::text AS kind,
               created_at_ms::float8 AS created_at_ms, NULL::float8 AS retired_at_ms`,
            [draft.draftId, draft.name, draft.game, createdAtMs, searchText(draft.name, draft.game)]);
          if (inserted.rows[0]) return entry(inserted.rows[0]);
          const raced = await client.query<DirectoryRow>(
            `SELECT id::text AS event_id, name, game, NULL::text AS status, 'signup'::text AS kind,
               created_at_ms::float8 AS created_at_ms, NULL::float8 AS retired_at_ms
             FROM public.tcg_tournament_directory WHERE id = $1`, [draft.draftId]);
          const row = raced.rows[0];
          if (!row || row.name !== draft.name || row.game !== draft.game)
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
    if (names === `${base},tcg_tournament_directory`) return 'already_ready';
    if (names !== base) throw new DirectoryUnavailableError('Tournament directory setup refused: unexpected public schema.');
    const sql = await readFile(new URL('../../../../database/migrations/003_tournament_directory.sql', import.meta.url), 'utf8');
    await client.query(sql);
    return 'created';
  }));
}
