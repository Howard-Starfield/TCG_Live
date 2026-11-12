ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS banner_style text NOT NULL DEFAULT 'game'
  CHECK (banner_style IN ('game', 'compact'));

ALTER TABLE public.tcg_tournament_directory
  ADD COLUMN IF NOT EXISTS signup_channel_id text
  CHECK (signup_channel_id ~ '^[1-9][0-9]{14,21}$');
