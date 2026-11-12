import type { ArtworkGame } from './artwork-contract.js';

export type SignupBannerStyle = 'game' | 'compact';

export interface TournamentDetailsDto {
  eventId: string;
  name: string;
  game: ArtworkGame | null;
  description: string;
  configured: boolean;
  bannerStyle?: SignupBannerStyle;
  applyStatus?: 'applied' | 'pending';
  applyMessage?: string;
}

export interface SaveTournamentDetailsDto {
  name: string;
  game: ArtworkGame;
  description: string;
  bannerStyle?: SignupBannerStyle;
}

export interface TournamentDirectoryEntryDto {
  eventId: string;
  name: string;
  game: ArtworkGame | null;
  status: 'draft' | 'active' | 'retired';
  kind: 'signup' | 'legacy';
  createdAtMs: number;
  retiredAtMs: number | null;
  matchMinutes?: number;
  description?: string;
  bannerStyle?: SignupBannerStyle;
  signupChannelId?: string;
}

export interface TournamentDirectoryDto {
  entries: TournamentDirectoryEntryDto[];
  defaultGame: ArtworkGame;
}

export interface CreateTournamentDraftDto {
  draftId: string;
  name?: string;
  game: ArtworkGame;
  description?: string;
  matchMinutes?: number;
  bannerStyle?: SignupBannerStyle;
  signupChannelId?: string;
}

export interface TournamentSignupChannelDto {
  id: string;
  name: string;
}

export const DEFAULT_MATCH_MINUTES = 30;
export const MAX_MATCH_MINUTES = 180;

export interface OpenTournamentSignupRequest {
  expectedActiveEventId: string | null;
}

export interface OpenTournamentSignupResult {
  eventId: string;
  panels: 'posted' | 'pending';
}
