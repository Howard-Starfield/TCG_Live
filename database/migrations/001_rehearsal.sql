CREATE TABLE public.tcg_rehearsal_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO public.tcg_rehearsal_meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE public.tcg_rehearsal_events (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 0),
  state jsonb NOT NULL
);

CREATE TABLE public.tcg_rehearsal_audit (
  event_id uuid NOT NULL REFERENCES public.tcg_rehearsal_events(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  command_id text NOT NULL,
  actor_id text NOT NULL,
  command_hash text NOT NULL,
  action jsonb NOT NULL,
  outcome jsonb NOT NULL,
  occurred_at_ms bigint NOT NULL,
  mode text,
  PRIMARY KEY (event_id, sequence),
  UNIQUE (event_id, command_id)
);
