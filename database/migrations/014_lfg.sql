-- LFG (looking for a game). Additive and idempotent; runs after 013 (setupAdminToolsSchema applies both).
-- Settings are one versioned document per guild; posts keep their joiners in their own table (no cap).
-- Every mutation is also audited in tcg_ops_audit (012).

CREATE TABLE IF NOT EXISTS public.tcg_lfg_settings (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  version integer NOT NULL CHECK (version >= 1),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 64)
);

CREATE TABLE IF NOT EXISTS public.tcg_lfg_posts (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK (guild_id ~ '^[1-9][0-9]{14,21}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[1-9][0-9]{14,21}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[1-9][0-9]{14,21}$'),
  author_id text NOT NULL CHECK (author_id ~ '^[1-9][0-9]{14,21}$'),
  game text NOT NULL CHECK (char_length(game) BETWEEN 1 AND 60),
  format text CHECK (format IS NULL OR char_length(format) BETWEEN 1 AND 60),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  voice_channel_id text CHECK (voice_channel_id IS NULL OR voice_channel_id ~ '^[1-9][0-9]{14,21}$'),
  status text NOT NULL CHECK (status IN ('posting', 'open', 'closed', 'expired', 'deleted')),
  pinged_role_id text CHECK (pinged_role_id IS NULL OR pinged_role_id ~ '^[1-9][0-9]{14,21}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  closed_at_ms bigint,
  closed_by text CHECK (closed_by IS NULL OR char_length(closed_by) BETWEEN 1 AND 64),
  CONSTRAINT tcg_lfg_posts_closed_marked CHECK ((status IN ('posting', 'open')) = (closed_at_ms IS NULL))
);
-- Expiry scheduler (and its restart catch-up), max-open and cooldown checks, ping cooldown, card lookups.
CREATE INDEX IF NOT EXISTS tcg_lfg_posts_due_idx ON public.tcg_lfg_posts (guild_id, expires_at_ms) WHERE status IN ('posting', 'open');
CREATE INDEX IF NOT EXISTS tcg_lfg_posts_author_idx ON public.tcg_lfg_posts (guild_id, author_id, created_at_ms);
CREATE INDEX IF NOT EXISTS tcg_lfg_posts_ping_idx ON public.tcg_lfg_posts (guild_id, pinged_role_id, created_at_ms) WHERE pinged_role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tcg_lfg_posts_message_idx ON public.tcg_lfg_posts (guild_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tcg_lfg_posts_list_idx ON public.tcg_lfg_posts (guild_id, created_at_ms);

CREATE TABLE IF NOT EXISTS public.tcg_lfg_players (
  post_id uuid NOT NULL REFERENCES public.tcg_lfg_posts (id) ON DELETE CASCADE,
  user_id text NOT NULL CHECK (user_id ~ '^[1-9][0-9]{14,21}$'),
  joined_at_ms bigint NOT NULL CHECK (joined_at_ms > 0),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS tcg_lfg_players_order_idx ON public.tcg_lfg_players (post_id, joined_at_ms);
