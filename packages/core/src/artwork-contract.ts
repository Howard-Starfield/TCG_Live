export const ARTWORK_GAMES = ['one-piece', 'one-punch-man', 'pokemon'] as const;
export const ARTWORK_SLOTS = ['banner', 'thumbnail'] as const;
export type ArtworkGame = typeof ARTWORK_GAMES[number];
export type ArtworkSlot = typeof ARTWORK_SLOTS[number];

export interface ArtworkSelectionDto {
  source: 'default' | 'custom' | 'none';
  contentType: 'image/gif' | 'image/png' | 'image/jpeg' | null;
  width: number | null;
  height: number | null;
  /** Changes whenever the selected bytes change. Useful for preview cache keys. */
  revision: string | null;
}

export interface ArtworkProfileDto {
  activeGame: ArtworkGame | null;
  games: Record<ArtworkGame, Record<ArtworkSlot, ArtworkSelectionDto>>;
  /** A malformed saved profile was ignored; its original bytes remain on disk until a setting is saved. */
  loadIssue?: string;
}
