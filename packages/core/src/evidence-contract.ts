// Evidence contract v1, shared by apps/server and apps/web. See docs/VIDEO_EVIDENCE_AND_MODERATION_PLAN.md.
// Video cannot be bot-recorded: video evidence is always a player or admin submitted file or link.
// The bot records match-room audio only (kind 'voice').
import type { MatchId, Seat, Snowflake } from './admin-contract.js';

export const EVIDENCE_KINDS = ['upload', 'link', 'voice'] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
/** Where the evidence came from: a Discord submission, the dashboard, or the bot's own audio recorder. */
export const EVIDENCE_SOURCES = ['discord', 'web', 'bot'] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];
export const EVIDENCE_STATUSES = ['pending', 'stored', 'failed', 'deleted'] as const;
export type EvidenceStatus = typeof EVIDENCE_STATUSES[number];

/** Discord user ID of a player or organizer, the local dashboard admin, or the bot recorder. */
export type EvidenceSubmitter = Snowflake | 'local-admin' | 'bot';

export interface EvidenceItemDto {
  id: string;                         // UUID
  eventId: string;
  matchId: MatchId;
  /** The proposal revision the evidence belongs to (a dispute), or null. */
  proposalRevision: number | null;
  kind: EvidenceKind;
  source: EvidenceSource;
  submittedBy: EvidenceSubmitter;
  seat: Seat | null;
  note: string;
  originalName: string | null;
  mime: string | null;
  byteSize: number | null;
  sha256: string | null;
  durationMs: number | null;
  /** https link for kind 'link'; open in a new tab with rel=noopener. */
  externalUrl: string | null;
  /** False for stored files a browser cannot play inline (for example MKV): offer download only. */
  playable: boolean;
  status: EvidenceStatus;
  hold: boolean;
  createdAtMs: number;
  deletedAtMs: number | null;
  deleteReason: string | null;
  /** Bot voice recordings (kind 'voice') only: the seated player whose audio this track holds. */
  recordedUserId?: string | null;
  /** Bot voice recordings only: wall-clock time of the track's first sample (granule 0). */
  recordingStartedAtMs?: number | null;
}

export interface EvidenceListDto { eventId: string; matchId: MatchId; items: EvidenceItemDto[] }

/** POST /api/v1/events/:id/matches/:m/evidence with Content-Type application/json. */
export interface CreateLinkEvidenceRequestDto { url: string; note?: string }
/** Answer to link creation and to a binary upload (POST same path with a media Content-Type). */
export interface CreateEvidenceResponseDto { item: EvidenceItemDto }
export type EvidenceUploadResponseDto = CreateEvidenceResponseDto;
/** Answer to PATCH and DELETE /api/v1/evidence/:id. */
export type EvidenceItemResponseDto = CreateEvidenceResponseDto;

/** PATCH /api/v1/evidence/:id */
export interface UpdateEvidenceRequestDto { hold: boolean }
/** DELETE /api/v1/evidence/:id; a soft delete that also removes the stored file. */
export interface DeleteEvidenceRequestDto { reason: string }

/** POST /api/v1/evidence/:id/playback. `url` is `/api/v1/media/<ticket>`, valid for the issuing session only. */
export interface PlaybackTicketDto { url: string; expiresAtMs: number }

export const EVIDENCE_NOTE_MAX_LENGTH = 500;
export const EVIDENCE_URL_MAX_LENGTH = 2048;
export const EVIDENCE_DELETE_REASON_MAX_LENGTH = 500;
export const EVIDENCE_ORIGINAL_NAME_MAX_LENGTH = 200;
export const EVIDENCE_LIST_LIMIT = 200;
export const EVIDENCE_PLAYER_MAX_BYTES = 100 * 1024 * 1024;
export const EVIDENCE_ADMIN_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const EVIDENCE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
/** New writes are refused when the evidence volume has less free space than this. */
export const EVIDENCE_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const PLAYBACK_TICKET_TTL_MS = 15 * 60_000;

/** Stored file types: checked against the file's first bytes, never trusted from the client alone. */
export const EVIDENCE_FILE_TYPES = {
  mp4: { mime: 'video/mp4', playable: true },
  mov: { mime: 'video/quicktime', playable: true },
  webm: { mime: 'video/webm', playable: true },
  ogg: { mime: 'audio/ogg', playable: true },
  mp3: { mime: 'audio/mpeg', playable: true },
  m4a: { mime: 'audio/mp4', playable: true },
  mkv: { mime: 'video/x-matroska', playable: false }
} as const;
export type EvidenceFileExtension = keyof typeof EVIDENCE_FILE_TYPES;
export function isEvidenceFileExtension(value: unknown): value is EvidenceFileExtension {
  return typeof value === 'string' && Object.hasOwn(EVIDENCE_FILE_TYPES, value);
}
