// Match rooms contract: the pool of numbered "tables" the bot keeps for public match voice rooms, their naming
// template, room chat transcripts and the post-event clean-up. Shared by apps/server and apps/web.
// Spec: docs/MATCH_ROOMS_BRIEF.md.
import type { MatchId, MemberDto, Snowflake } from './admin-contract.js';
import type { VoiceRoomStatus } from './moderation-contract.js';

export const MATCH_ROOM_TEMPLATE_TOKENS = ['match', 'n', 'table', 'round', 'event', 'game'] as const;
export type MatchRoomTemplateToken = typeof MATCH_ROOM_TEMPLATE_TOKENS[number];
export const MATCH_ROOM_DEFAULT_TEMPLATE = '🎮 {match}';
export const MATCH_ROOM_TEMPLATE_PRESETS = ['🎮 {match}', '{table} · {round}', '⚔️ {round} · {match}'] as const;
export const MATCH_ROOM_LIMITS = { tablesPerCategory: 50, serverChannels: 500, nameLength: 100, eventNameLength: 40,
  renamesPerWindow: 2, renameWindowMs: 600_000 } as const;
export const MATCH_ROOM_RENAME_NOTICE = 'Queued — Discord allows 2 renames per 10 minutes.';

export interface MatchRoomNameContext {
  matchId: MatchId; table: number; round: number; eventName: string | null; gameLabel: string | null;
}

const TOKEN_PATTERN = /\{([^{}]*)\}/g;
// Control characters, plus the line and paragraph separators. No `g` flag, so `.test` keeps no state.
const CONTROL_PATTERN = /[\p{Cc}\u2028\u2029]/u;
const CONTROL_GLOBAL = /[\p{Cc}\u2028\u2029]/gu;
const GAME_FALLBACK = 'TCG';
const GAME_LABEL_LENGTH = 30;
// Longer than anything today's single round produces, so a template that fits now keeps fitting.
const WORST_CASE: MatchRoomNameContext = { matchId: 'M500', table: 500, round: 99,
  eventName: 'E'.repeat(MATCH_ROOM_LIMITS.eventNameLength), gameLabel: 'G'.repeat(GAME_LABEL_LENGTH) };

function codePoints(text: string): number { let n = 0; for (const _ of text) n += 1; return n; }
function fitsName(text: string): boolean {
  return codePoints(text) <= MATCH_ROOM_LIMITS.nameLength && text.length <= MATCH_ROOM_LIMITS.nameLength;
}
function tidy(text: string): string { return text.replace(CONTROL_GLOBAL, ' ').replace(/\s+/g, ' ').trim(); }
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function renderRaw(t: string, c: MatchRoomNameContext): string {
  const values: Record<MatchRoomTemplateToken, string> = {
    match: c.matchId, n: String(c.table), table: `Table ${c.table}`, round: `Round ${c.round}`,
    event: sanitizeEventName(c.eventName), game: tidy(c.gameLabel ?? '') || GAME_FALLBACK,
  };
  return tidy(t.replace(TOKEN_PATTERN, (whole, token: string) =>
    (MATCH_ROOM_TEMPLATE_TOKENS as readonly string[]).includes(token) ? values[token as MatchRoomTemplateToken] : whole));
}

/** Null when the template is acceptable, else the reason it is refused. */
export function validateMatchRoomTemplate(t: string): string | null {
  if (typeof t !== 'string' || !t.trim()) return 'Enter a name template.';
  if (CONTROL_PATTERN.test(t)) return 'The template cannot contain line breaks or control characters.';
  const known = new Set<string>(MATCH_ROOM_TEMPLATE_TOKENS);
  const used = new Set<string>();
  for (const found of t.matchAll(TOKEN_PATTERN)) {
    const token = found[1] ?? '';
    if (token === 'stage') return '{stage} is coming with brackets.';
    if (!known.has(token)) return `Unknown token {${token}}. Use ${MATCH_ROOM_TEMPLATE_TOKENS.map((x) => `{${x}}`).join(', ')}.`;
    used.add(token);
  }
  if (/[{}]/.test(t.replace(TOKEN_PATTERN, ''))) return 'Unmatched { or }. Wrap a token like {match}.';
  if (!used.has('match') && !used.has('n') && !used.has('table')) return 'Include {match}, {n} or {table} so every room has its own name.';
  if (!fitsName(renderRaw(t, WORST_CASE))) return `The name could pass ${MATCH_ROOM_LIMITS.nameLength} characters with a long event or game name. Shorten the template.`;
  return null;
}

/** The channel name for a table. Never empty, and never longer than Discord's limit. */
export function renderMatchRoomName(t: string, c: MatchRoomNameContext): string {
  let name = renderRaw(t, c);
  if (!name) name = `Match ${c.table}`;
  while (!fitsName(name)) name = [...name].slice(0, -1).join('');
  return name;
}

export function sanitizeEventName(name: string | null): string {
  if (!name) return '';
  return clip(tidy(name), MATCH_ROOM_LIMITS.eventNameLength);
}

/** Null when a channel name is acceptable: 1–100 readable characters. */
export function validMatchRoomName(name: string): string | null {
  if (typeof name !== 'string') return 'Enter a room name.';
  const text = name.trim();
  if (!text) return 'Enter a room name.';
  if (CONTROL_PATTERN.test(text)) return 'The name cannot contain line breaks or control characters.';
  if (!fitsName(text)) return `Use ${MATCH_ROOM_LIMITS.nameLength} characters or fewer.`;
  return null;
}

/** "One Piece 51–100" (en dash). A null or blank game falls back to "TCG". */
export function overflowCategoryName(gameLabel: string | null, from: number, to: number): string {
  const game = clip(tidy(gameLabel ?? ''), GAME_LABEL_LENGTH) || GAME_FALLBACK;
  return `${game} ${from}–${to}`;
}

/** Tables 1–50 are index 0, 51–100 index 1, and so on. */
export function categoryRangeForTable(table: number): { index: number; from: number; to: number } {
  const size = MATCH_ROOM_LIMITS.tablesPerCategory;
  const index = Math.floor((Math.max(1, Math.floor(table)) - 1) / size);
  return { index, from: index * size + 1, to: (index + 1) * size };
}

export type MatchRoomRenameState = 'synced' | 'queued' | 'retrying' | 'failed';

export interface MatchRoomSettingsDto {
  version: number; template: string; categoryId: Snowflake | null; categoryName: string | null;
  pendingCategoryName: string | null; baselineChannelIds: Snowflake[]; baselineCapturedAtMs: number | null;
}
export interface SaveMatchRoomSettingsRequestDto {
  expectedVersion: number; template: string; categoryId: Snowflake | null; createCategory: string | null;
  baselineChannelIds: Snowflake[];
}
export interface MatchRoomDto {
  channelId: Snowflake; table: number; categoryId: Snowflake | null; origin: 'created' | 'adopted';
  name: string | null; missing: boolean; customName: string | null; templateName: string; pendingName: string | null;
  rename: { state: MatchRoomRenameState; nextAttemptAtMs: number | null; error: string | null };
  assignedMatch: MatchId | null; connected: MemberDto[] | null; recording: VoiceRoomStatus | null;
  removeBlockedReason: string | null;
}
export interface MatchRoomCategoryDto {
  categoryId: Snowflake; name: string | null; from: number; to: number; origin: 'created' | 'configured'; missing: boolean;
}
export interface BaselineChannelDto {
  id: Snowflake; name: string; type: 'voice' | 'stage' | 'category'; inBaseline: boolean; botCreated: boolean;
}
export interface MatchRoomsDto {
  guildId: Snowflake; /** 'demo': the demo's in-memory pool, memory by design (no "run npm start" hint). */
  storage: 'postgres' | 'memory' | 'demo'; canManageChannels: boolean; problem: string | null;
  activeEventId: string | null; eventName: string | null; gameLabel: string | null; round: number;
  freeChannelSlots: number | null; settings: MatchRoomSettingsDto; categories: MatchRoomCategoryDto[];
  rooms: MatchRoomDto[]; baseline: BaselineChannelDto[];
}
export interface CleanupPlanItemDto {
  channelId: Snowflake; name: string | null; kind: 'room' | 'category';
  action: 'delete' | 'restore' | 'keep' | 'skip'; reason: string; restoreName?: string | null;
}
export interface CleanupPlanDto { eventId: string | null; items: CleanupPlanItemDto[]; transcriptsToArchive: number; planToken: string }
export interface CleanupResultDto {
  deleted: Snowflake[]; restored: Snowflake[]; skipped: Array<{ channelId: Snowflake; reason: string }>; archived: number;
}
export interface MatchRoomTranscriptMessageDto {
  id: Snowflake; authorId: Snowflake; authorName: string | null; createdAtMs: number; content: string | null;
  attachments: Array<{ name: string; url: string; size: number | null }>;
}
export interface MatchRoomTranscriptDto {
  id: string; eventId: string; matchId: MatchId; channelId: Snowflake; channelName: string | null;
  startedAtMs: number | null; archivedAtMs: number; reason: 'reassigned' | 'cleanup' | 'manual'; messageCount: number;
  contentAvailable: boolean; skippedOld: number; hold: boolean; messages: MatchRoomTranscriptMessageDto[];
}
export type MatchRoomTranscriptSummaryDto = Omit<MatchRoomTranscriptDto, 'messages'>;

/** The setup wizard's choice: put rooms in this category, or create one. */
export interface SetupMatchRoomsDto { categoryId: Snowflake | null; createCategory: boolean }

/** Spread into ADMIN_TOOLS_AUDIT_KINDS. */
export const MATCH_ROOMS_AUDIT_KINDS = ['match_rooms.settings', 'match_rooms.renamed', 'match_rooms.created', 'match_rooms.removed',
  'match_rooms.adopted', 'match_rooms.forgotten', 'match_rooms.cleanup', 'match_rooms.restored', 'match_rooms.transcript'] as const;
