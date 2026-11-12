ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS match_minutes integer NOT NULL DEFAULT 1
  CHECK (match_minutes BETWEEN 1 AND 180);
