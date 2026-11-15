-- Evidence and moderation (docs/VIDEO_EVIDENCE_AND_MODERATION_PLAN.md). Additive and idempotent.
-- Evidence files live under data/evidence/ and are not in pg_dump. Bot tokens are never stored here.

CREATE TABLE IF NOT EXISTS public.tcg_evidence (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.tcg_rehearsal_events(id),
  match_id text NOT NULL CHECK (match_id ~ '^M[1-9][0-9]{0,3}$'),
  proposal_revision integer CHECK (proposal_revision IS NULL OR proposal_revision >= 0),
  kind text NOT NULL CHECK (kind IN ('upload', 'link', 'voice')),
  source text NOT NULL CHECK (source IN ('discord', 'web', 'bot')),
  submitted_by text NOT NULL CHECK (submitted_by ~ '^([1-9][0-9]{14,21}|local-admin|bot)$'),
  seat text CHECK (seat IS NULL OR seat ~ '^([ABCD]|P[1-9][0-9]{0,3})$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  storage_path text CHECK (storage_path IS NULL OR
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|mov|webm|ogg|mp3|m4a|mkv)$'),
  original_name text CHECK (original_name IS NULL OR char_length(original_name) <= 200),
  mime text CHECK (mime IS NULL OR char_length(mime) <= 100),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  external_url text CHECK (external_url IS NULL OR (char_length(external_url) <= 2048 AND external_url LIKE 'https://%')),
  status text NOT NULL CHECK (status IN ('pending', 'stored', 'failed', 'deleted')),
  hold boolean NOT NULL DEFAULT false,
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  deleted_at_ms bigint,
  delete_reason text CHECK (delete_reason IS NULL OR char_length(delete_reason) <= 500),
  recorded_user_id text CHECK (recorded_user_id IS NULL OR recorded_user_id ~ '^[1-9][0-9]{14,21}$'),
  recording_started_at_ms bigint CHECK (recording_started_at_ms IS NULL OR recording_started_at_ms > 0),
  CONSTRAINT tcg_evidence_link_has_url CHECK (kind <> 'link' OR (external_url IS NOT NULL AND storage_path IS NULL)),
  CONSTRAINT tcg_evidence_file_has_path CHECK (kind = 'link' OR external_url IS NULL),
  CONSTRAINT tcg_evidence_deleted_marked CHECK ((status = 'deleted') = (deleted_at_ms IS NOT NULL))
);
-- Databases that applied an earlier draft of 012 get the voice-recording columns too.
ALTER TABLE public.tcg_evidence ADD COLUMN IF NOT EXISTS recorded_user_id text
  CHECK (recorded_user_id IS NULL OR recorded_user_id ~ '^[1-9][0-9]{14,21}$');
ALTER TABLE public.tcg_evidence ADD COLUMN IF NOT EXISTS recording_started_at_ms bigint
  CHECK (recording_started_at_ms IS NULL OR recording_started_at_ms > 0);
CREATE INDEX IF NOT EXISTS tcg_evidence_match_idx
  ON public.tcg_evidence (event_id, match_id, created_at_ms, id);
CREATE INDEX IF NOT EXISTS tcg_evidence_retention_idx
  ON public.tcg_evidence (status, hold, created_at_ms) WHERE status <> 'deleted';

-- Append-only operations log, separate from tcg_rehearsal_audit so result replay stays unchanged.
CREATE TABLE IF NOT EXISTS public.tcg_ops_audit (
  id bigserial PRIMARY KEY,
  event_id uuid,
  guild_id text CHECK (guild_id IS NULL OR guild_id ~ '^[1-9][0-9]{14,21}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_.]{2,63}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('admin', 'player', 'bot', 'system')),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 64),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms > 0)
);
CREATE INDEX IF NOT EXISTS tcg_ops_audit_event_idx ON public.tcg_ops_audit (event_id, id);

CREATE TABLE IF NOT EXISTS public.tcg_moderation_settings (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  version integer NOT NULL CHECK (version >= 1),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  automod_rule_ids jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(automod_rule_ids) = 'object'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 64)
);

CREATE TABLE IF NOT EXISTS public.tcg_moderation_flags (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('keyword', 'volume')),
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[1-9][0-9]{14,21}$'),
  event_id uuid,
  match_id text CHECK (match_id IS NULL OR match_id ~ '^M[1-9][0-9]{0,3}$'),
  user_id text CHECK (user_id IS NULL OR user_id ~ '^[1-9][0-9]{14,21}$'),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms > 0)
);
