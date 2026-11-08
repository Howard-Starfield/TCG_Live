import type { ArtworkGame } from './artwork-contract.js';

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
