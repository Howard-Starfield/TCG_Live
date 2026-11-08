-- Presentation metadata only; no tournament rules or aggregate state change.
ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''
  CHECK (char_length(description) <= 500);
