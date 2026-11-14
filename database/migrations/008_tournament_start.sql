ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS starts_at_ms bigint;
