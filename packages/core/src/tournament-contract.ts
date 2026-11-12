import type { ArtworkGame } from './artwork-contract.js';

export interface TournamentDetailsDto {
  eventId: string;
  name: string;
  game: ArtworkGame | null;
  description: string;
  configured: boolean;
  applyStatus?: 'applied' | 'pending';
  applyMessage?: string;
}

export interface SaveTournamentDetailsDto {
  name: string;
  game: ArtworkGame;
  description: string;
}

export interface TournamentDirectoryEntryDto {
  eventId: string;
  name: string;
  game: ArtworkGame | null;
  status: 'draft' | 'active' | 'retired';
  kind: 'signup' | 'legacy';
  createdAtMs: number;
  retiredAtMs: number | null;
}

export interface TournamentDirectoryDto {
  entries: TournamentDirectoryEntryDto[];
  defaultGame: ArtworkGame;
}

export interface CreateTournamentDraftDto {
  draftId: string;
  name?: string;
  game: ArtworkGame;
}

export interface OpenTournamentSignupRequest {
  expectedActiveEventId: string | null;
}

export interface OpenTournamentSignupResult {
  eventId: string;
  panels: 'posted' | 'pending';
}
