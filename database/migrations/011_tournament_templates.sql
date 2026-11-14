ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false
  CONSTRAINT tcg_template_has_no_schedule
  CHECK (NOT is_template OR (starts_at_ms IS NULL AND signup_opens_at_ms IS NULL));
