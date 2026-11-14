import type { ArtworkGame } from './artwork-contract.js';

export interface TournamentSwissRules {
  matchFormat: 'bo1' | 'bo3';
  roundCount: number;
  finish: 'standings' | 'playoffs';
  roundRelease: 'automatic' | 'manual';
  winPoints: number;
  drawPoints: number;
  lossPoints: number;
  gameWinPoints: number;
  gameTiePoints: number;
  byePoints: number;
}

export const DEFAULT_TOURNAMENT_SWISS_RULES: Readonly<TournamentSwissRules> = {
  matchFormat: 'bo1', roundCount: 0, finish: 'standings', roundRelease: 'automatic',
  winPoints: 3, drawPoints: 1, lossPoints: 0, gameWinPoints: 0, gameTiePoints: 0, byePoints: 3
};

export type SignupBannerStyle = 'game' | 'compact';

export interface TournamentDetailsDto {
  eventId: string;
  name: string;
  game: ArtworkGame | null;
  description: string;
  configured: boolean;
  startsAtMs?: number;
  signupOpensAtMs?: number;
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
  isTemplate?: boolean;
  completed?: boolean;
  matchMinutes?: number;
  description?: string;
  bannerStyle?: SignupBannerStyle;
  signupChannelId?: string;
  startsAtMs?: number;
  signupOpensAtMs?: number;
  signupCapacity?: number;
  swissRules?: TournamentSwissRules;
}

export interface TournamentDirectoryDto {
  entries: TournamentDirectoryEntryDto[];
  defaultGame: ArtworkGame;
}

export interface CreateTournamentDraftDto {
  draftId: string;
  isTemplate?: boolean;
  name?: string;
  game: ArtworkGame;
  description?: string;
  matchMinutes?: number;
  bannerStyle?: SignupBannerStyle;
  signupChannelId?: string;
  startsAtMs?: number;
  signupOpensAtMs?: number;
  signupCapacity?: number;
  swissRules?: TournamentSwissRules;
}

export interface TournamentSignupChannelDto {
  id: string;
  name: string;
}

export const DEFAULT_SIGNUP_CAPACITY = 100;
export const MAX_SIGNUP_CAPACITY = 1000;

export const DEFAULT_MATCH_MINUTES = 30;
export const MAX_MATCH_MINUTES = 180;

export interface OpenTournamentSignupRequest {
  expectedActiveEventId: string | null;
}

export interface OpenTournamentSignupResult {
  eventId: string;
  panels: 'posted' | 'pending';
}
