ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS signup_opens_at_ms bigint;

CREATE INDEX IF NOT EXISTS tcg_tournament_signup_opening
  ON public.tcg_tournament_directory (signup_opens_at_ms)
  WHERE signup_opens_at_ms IS NOT NULL;

UPDATE public.tcg_rehearsal_events event
SET state = jsonb_set(event.state, '{startsAtMs}', to_jsonb(details.starts_at_ms))
FROM public.tcg_tournament_directory details, public.tcg_rehearsal_sessions session
WHERE details.id = event.id AND session.event_id = event.id AND session.status = 'active'
  AND details.starts_at_ms IS NOT NULL AND event.state->>'published' = 'false'
  AND NOT (event.state ? 'startsAtMs');
