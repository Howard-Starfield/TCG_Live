-- Who acted: the Discord member's names and staff role, kept with each audit row so the history survives renames.
-- Additive and idempotent; applied by setupAdminToolsSchema right after 014. Rows written before it have NULL.
ALTER TABLE public.tcg_rehearsal_audit
  ADD COLUMN IF NOT EXISTS actor_snapshot jsonb
  CHECK (actor_snapshot IS NULL OR (jsonb_typeof(actor_snapshot) = 'object' AND pg_column_size(actor_snapshot) < 1024));
