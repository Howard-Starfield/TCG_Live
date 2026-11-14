ALTER TABLE public.tcg_rehearsal_sessions
  ADD COLUMN IF NOT EXISTS deleted_at_ms bigint;
