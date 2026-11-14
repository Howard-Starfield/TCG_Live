ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS signup_capacity integer CHECK (signup_capacity BETWEEN 4 AND 1000);

ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS swiss_rules jsonb;
