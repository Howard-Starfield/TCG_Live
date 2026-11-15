-- Admin tools (docs/ADMIN_TOOLS_PROPOSAL.md, Decisions). Additive and idempotent; runs after 012.
-- Every mutation is also audited in tcg_ops_audit (012). Bot tokens are never stored here.

-- Per-guild gap-free counters ('case', 'ticket'). Allocate inside the transaction that inserts the row:
-- INSERT ... ON CONFLICT DO UPDATE SET last_value = last_value + 1 RETURNING last_value (row-locked).
CREATE TABLE IF NOT EXISTS public.tcg_admin_counters (
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  name text NOT NULL CHECK (name IN ('case', 'ticket')),
  last_value integer NOT NULL CHECK (last_value >= 0),
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS public.tcg_admin_tools_settings (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  version integer NOT NULL CHECK (version >= 1),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 64)
);

CREATE TABLE IF NOT EXISTS public.tcg_mod_cases (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  number integer NOT NULL CHECK (number >= 1),
  kind text NOT NULL CHECK (kind IN ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban')),
  target_id text NOT NULL CHECK (target_id ~ '^[1-9][0-9]{14,21}$'),
  moderator_kind text NOT NULL CHECK (moderator_kind IN ('admin', 'member', 'bot', 'external')),
  moderator_id text NOT NULL CHECK (char_length(moderator_id) BETWEEN 1 AND 64),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  evidence_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_ids) <= 10),
  event_id uuid,
  match_id text CHECK (match_id IS NULL OR match_id ~ '^M[1-9][0-9]{0,3}$'),
  source text NOT NULL CHECK (source IN ('dashboard', 'discord', 'external')),
  -- Discord audit-log entry merged into the case log (bans done outside the bot); deduplicates re-imports.
  discord_audit_entry_id text CHECK (discord_audit_entry_id IS NULL OR discord_audit_entry_id ~ '^[1-9][0-9]{14,21}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms bigint CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  expiry_handled_at_ms bigint CHECK (expiry_handled_at_ms IS NULL OR expires_at_ms IS NOT NULL),
  CONSTRAINT tcg_mod_cases_number_unique UNIQUE (guild_id, number)
);
CREATE INDEX IF NOT EXISTS tcg_mod_cases_target_idx ON public.tcg_mod_cases (guild_id, target_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS tcg_mod_cases_audit_entry_idx
  ON public.tcg_mod_cases (guild_id, discord_audit_entry_id) WHERE discord_audit_entry_id IS NOT NULL;
-- Tempban / long-timeout catch-up on restart.
CREATE INDEX IF NOT EXISTS tcg_mod_cases_expiry_idx
  ON public.tcg_mod_cases (expires_at_ms) WHERE expires_at_ms IS NOT NULL AND expiry_handled_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS public.tcg_mod_notes (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  target_id text NOT NULL CHECK (target_id ~ '^[1-9][0-9]{14,21}$'),
  author_id text NOT NULL CHECK (char_length(author_id) BETWEEN 1 AND 64),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms),
  deleted_at_ms bigint
);
CREATE INDEX IF NOT EXISTS tcg_mod_notes_target_idx ON public.tcg_mod_notes (guild_id, target_id, id) WHERE deleted_at_ms IS NULL;

-- General stickies. Never on a reserved tournament channel (enforced by the routes, which know the runtime).
CREATE TABLE IF NOT EXISTS public.tcg_sticky_messages (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  content text CHECK (content IS NULL OR char_length(content) <= 2000),
  embed jsonb CHECK (embed IS NULL OR jsonb_typeof(embed) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  debounce_ms integer NOT NULL CHECK (debounce_ms BETWEEN 5000 AND 600000),
  last_message_id text CHECK (last_message_id IS NULL OR last_message_id ~ '^[1-9][0-9]{14,21}$'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  CONSTRAINT tcg_sticky_messages_body CHECK (content IS NOT NULL OR embed IS NOT NULL),
  CONSTRAINT tcg_sticky_messages_channel_unique UNIQUE (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS public.tcg_tickets (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  number integer NOT NULL CHECK (number >= 1),
  opener_id text NOT NULL CHECK (opener_id ~ '^[1-9][0-9]{14,21}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[1-9][0-9]{14,21}$'),
  status text NOT NULL CHECK (status IN ('open', 'closed', 'deleted')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  closed_at_ms bigint,
  closed_by text CHECK (closed_by IS NULL OR char_length(closed_by) BETWEEN 1 AND 64),
  CONSTRAINT tcg_tickets_number_unique UNIQUE (guild_id, number),
  CONSTRAINT tcg_tickets_closed_marked CHECK ((status = 'open') = (closed_at_ms IS NULL))
);
-- One open ticket per member.
CREATE UNIQUE INDEX IF NOT EXISTS tcg_tickets_one_open_idx ON public.tcg_tickets (guild_id, opener_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tcg_tickets_closed_idx ON public.tcg_tickets (closed_at_ms) WHERE closed_at_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tcg_ticket_messages (
  ticket_id uuid NOT NULL REFERENCES public.tcg_tickets(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  message_id text NOT NULL CHECK (message_id ~ '^[1-9][0-9]{14,21}$'),
  author_id text NOT NULL CHECK (author_id ~ '^[1-9][0-9]{14,21}$'),
  author_name text NOT NULL CHECK (char_length(author_name) <= 100),
  author_bot boolean NOT NULL DEFAULT false,
  content text NOT NULL CHECK (char_length(content) <= 4000),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (ticket_id, seq)
);

CREATE TABLE IF NOT EXISTS public.tcg_button_role_panels (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[1-9][0-9]{14,21}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  mode text NOT NULL CHECK (mode IN ('toggle', 'unique')),
  buttons jsonb NOT NULL CHECK (jsonb_typeof(buttons) = 'array'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0)
);

CREATE TABLE IF NOT EXISTS public.tcg_bulk_role_jobs (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  action text NOT NULL CHECK (action IN ('add', 'remove')),
  role_id text NOT NULL CHECK (role_id ~ '^[1-9][0-9]{14,21}$'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  -- Resolved member IDs, frozen when queued; progress indexes into this list.
  user_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(user_ids) = 'array'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  done integer NOT NULL DEFAULT 0 CHECK (done >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 64),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  started_at_ms bigint,
  finished_at_ms bigint
);
CREATE INDEX IF NOT EXISTS tcg_bulk_role_jobs_open_idx ON public.tcg_bulk_role_jobs (created_at_ms) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS public.tcg_announcements (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  mention_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mention_role_ids) = 'array'),
  scheduled_at_ms bigint,
  status text NOT NULL CHECK (status IN ('draft', 'scheduled', 'sent', 'failed')),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[1-9][0-9]{14,21}$'),
  sent_at_ms bigint,
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0)
);
CREATE INDEX IF NOT EXISTS tcg_announcements_due_idx ON public.tcg_announcements (scheduled_at_ms) WHERE status = 'scheduled';

-- Join/leave/role/nickname events (needs the GuildMembers intent).
CREATE TABLE IF NOT EXISTS public.tcg_member_events (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  kind text NOT NULL CHECK (kind IN ('join', 'leave', 'role', 'nick')),
  user_id text NOT NULL CHECK (user_id ~ '^[1-9][0-9]{14,21}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms > 0)
);
CREATE INDEX IF NOT EXISTS tcg_member_events_user_idx ON public.tcg_member_events (guild_id, user_id, id);

-- Message edit/delete log (needs MessageContent; off by default; retention-purged).
CREATE TABLE IF NOT EXISTS public.tcg_message_log (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  kind text NOT NULL CHECK (kind IN ('edit', 'delete')),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  message_id text NOT NULL CHECK (message_id ~ '^[1-9][0-9]{14,21}$'),
  author_id text CHECK (author_id IS NULL OR author_id ~ '^[1-9][0-9]{14,21}$'),
  content_before text CHECK (content_before IS NULL OR char_length(content_before) <= 4000),
  content_after text CHECK (content_after IS NULL OR char_length(content_after) <= 4000),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms > 0)
);
CREATE INDEX IF NOT EXISTS tcg_message_log_time_idx ON public.tcg_message_log (occurred_at_ms);

-- Local copy of recent message text so deletes can be logged after the gateway cache is gone; retention-purged.
CREATE TABLE IF NOT EXISTS public.tcg_message_store (
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  message_id text NOT NULL CHECK (message_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  author_id text NOT NULL CHECK (author_id ~ '^[1-9][0-9]{14,21}$'),
  content text NOT NULL CHECK (char_length(content) <= 4000),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  edited_at_ms bigint,
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX IF NOT EXISTS tcg_message_store_time_idx ON public.tcg_message_store (created_at_ms);
