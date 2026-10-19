ALTER TABLE public.tcg_rehearsal_audit
  ADD COLUMN principal_kind text,
  ADD COLUMN principal_id text,
  ADD COLUMN interaction_id text;

CREATE TABLE public.tcg_rehearsal_sessions (
  event_id uuid PRIMARY KEY REFERENCES public.tcg_rehearsal_events(id),
  application_id text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  identity_map jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  checkin_message_id text,
  m1_message_id text,
  m2_message_id text,
  created_at_ms bigint NOT NULL,
  retired_at_ms bigint
);

CREATE UNIQUE INDEX tcg_rehearsal_one_active_session
  ON public.tcg_rehearsal_sessions ((status)) WHERE status = 'active';

UPDATE public.tcg_rehearsal_meta SET value = '2' WHERE key = 'schema_version' AND value = '1';
