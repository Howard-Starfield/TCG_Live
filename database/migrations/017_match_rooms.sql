-- Bot-managed match rooms: the pool of numbered "tables", their categories, the naming settings and room chat transcripts.
-- Additive and idempotent; applied by setupAdminToolsSchema right after 016. The four tables are optional in the schema
-- guards (rehearsal/schema-tables.ts), so a database with or without 017 has the same recognised shape.

CREATE TABLE IF NOT EXISTS public.tcg_match_room_settings (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  version integer NOT NULL CHECK (version >= 1),
  template text NOT NULL CHECK (char_length(template) BETWEEN 1 AND 100),
  category_id text CHECK (category_id IS NULL OR category_id ~ '^[1-9][0-9]{14,21}$'),
  pending_category_name text CHECK (pending_category_name IS NULL OR char_length(pending_category_name) BETWEEN 1 AND 100),
  baseline_channel_ids text[] NOT NULL DEFAULT '{}',
  baseline_captured_at_ms bigint CHECK (baseline_captured_at_ms IS NULL OR baseline_captured_at_ms > 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0)
);

CREATE TABLE IF NOT EXISTS public.tcg_match_room_categories (
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  category_id text NOT NULL CHECK (category_id ~ '^[1-9][0-9]{14,21}$'),
  range_from integer NOT NULL CHECK (range_from >= 1),
  range_to integer NOT NULL CHECK (range_to >= range_from),
  origin text NOT NULL CHECK (origin IN ('created', 'configured')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (guild_id, category_id)
);

CREATE TABLE IF NOT EXISTS public.tcg_match_rooms (
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  application_id text NOT NULL CHECK (application_id ~ '^[1-9][0-9]{14,21}$'),
  table_no integer NOT NULL CHECK (table_no >= 1),
  category_id text CHECK (category_id IS NULL OR category_id ~ '^[1-9][0-9]{14,21}$'),
  origin text NOT NULL CHECK (origin IN ('created', 'adopted')),
  custom_name text CHECK (custom_name IS NULL OR char_length(custom_name) BETWEEN 1 AND 100),
  applied_name text CHECK (applied_name IS NULL OR char_length(applied_name) BETWEEN 1 AND 100),
  desired_name text CHECK (desired_name IS NULL OR char_length(desired_name) BETWEEN 1 AND 100),
  original_name text CHECK (original_name IS NULL OR char_length(original_name) BETWEEN 1 AND 100),
  rename_log bigint[] NOT NULL DEFAULT '{}' CHECK (cardinality(rename_log) <= 4),
  next_rename_at_ms bigint,
  rename_error text CHECK (rename_error IS NULL OR char_length(rename_error) <= 200),
  missing_since_ms bigint,
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (guild_id, channel_id),
  UNIQUE (guild_id, table_no)
);

-- Room chat archived before a room gets a new match and before clean-up deletes it. Owned by the transcripts module.
CREATE TABLE IF NOT EXISTS public.tcg_match_room_transcripts (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  event_id text NOT NULL,
  match_id text NOT NULL CHECK (match_id ~ '^M[1-9][0-9]{0,3}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  channel_name text,
  started_at_ms bigint,
  archived_at_ms bigint NOT NULL CHECK (archived_at_ms > 0),
  reason text NOT NULL CHECK (reason IN ('reassigned', 'cleanup', 'manual')),
  message_count integer NOT NULL CHECK (message_count >= 0),
  content_available boolean NOT NULL,
  messages jsonb NOT NULL CHECK (jsonb_typeof(messages) = 'array'),
  skipped_old integer NOT NULL DEFAULT 0 CHECK (skipped_old >= 0),
  hold boolean NOT NULL DEFAULT false,
  deleted_at_ms bigint,
  CONSTRAINT tcg_match_room_transcripts_size CHECK (pg_column_size(messages) < 4000000)
);
CREATE INDEX IF NOT EXISTS tcg_match_room_transcripts_event_idx
  ON public.tcg_match_room_transcripts (guild_id, event_id, match_id, archived_at_ms);
CREATE INDEX IF NOT EXISTS tcg_match_room_transcripts_retention_idx
  ON public.tcg_match_room_transcripts (archived_at_ms) WHERE hold = false AND deleted_at_ms IS NULL;
