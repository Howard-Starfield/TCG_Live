-- Text-only evidence (kind 'note') and the evidence reply thread. Additive and idempotent; run by
-- `node dist/evidence/cli.js setup` right after 012.
--
-- A note keeps its text in the existing `note` column (no storage path, no link). That column was capped at 500
-- by an unnamed column check; the cap is now 500 for every kind except 'note', which allows 4000.

DO $$
BEGIN
  -- kind: add 'note'. Replace the 012 check only while it does not yet name 'note'.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass
      AND conname = 'tcg_evidence_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%''note''%') THEN
    ALTER TABLE public.tcg_evidence DROP CONSTRAINT tcg_evidence_kind_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass AND conname = 'tcg_evidence_kind_check') THEN
    ALTER TABLE public.tcg_evidence ADD CONSTRAINT tcg_evidence_kind_check
      CHECK (kind IN ('upload', 'link', 'voice', 'note'));
  END IF;

  -- note length: the 012 column check (<= 500) becomes a kind-aware limit.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass AND conname = 'tcg_evidence_note_check') THEN
    ALTER TABLE public.tcg_evidence DROP CONSTRAINT tcg_evidence_note_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass AND conname = 'tcg_evidence_note_length') THEN
    ALTER TABLE public.tcg_evidence ADD CONSTRAINT tcg_evidence_note_length
      CHECK (char_length(note) <= CASE WHEN kind = 'note' THEN 4000 ELSE 500 END);
  END IF;

  -- an earlier draft of this check demanded text even on deleted rows.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass
      AND conname = 'tcg_evidence_note_is_text' AND pg_get_constraintdef(oid) NOT LIKE '%deleted%') THEN
    ALTER TABLE public.tcg_evidence DROP CONSTRAINT tcg_evidence_note_is_text;
  END IF;
  -- a note is text only: no file, no link, and the text is not blank. A deleted note has its text blanked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass AND conname = 'tcg_evidence_note_is_text') THEN
    ALTER TABLE public.tcg_evidence ADD CONSTRAINT tcg_evidence_note_is_text
      CHECK (kind <> 'note' OR ((status = 'deleted' OR char_length(btrim(note)) > 0) AND storage_path IS NULL AND external_url IS NULL
        AND original_name IS NULL AND mime IS NULL AND byte_size IS NULL AND sha256 IS NULL AND duration_ms IS NULL));
  END IF;
END
$$;

-- The reply thread for a match's evidence. 'players' replies are posted to the match's players in Discord by
-- the bot; 'staff' replies stay in the dashboard. Replies are never deleted (the thread is part of the record).
CREATE TABLE IF NOT EXISTS public.tcg_evidence_replies (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.tcg_rehearsal_events(id),
  match_id text NOT NULL CHECK (match_id ~ '^M[1-9][0-9]{0,3}$'),
  author text NOT NULL CHECK (author ~ '^([1-9][0-9]{14,21}|local-admin)$'),
  body text NOT NULL CHECK (char_length(btrim(body)) > 0 AND char_length(body) <= 1500),
  audience text NOT NULL CHECK (audience IN ('players', 'staff')),
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'recorded')),
  discord_message_id text CHECK (discord_message_id IS NULL OR discord_message_id ~ '^[1-9][0-9]{14,21}$'),
  delivery_error text CHECK (delivery_error IS NULL OR char_length(delivery_error) <= 200),
  attempted_at_ms bigint CHECK (attempted_at_ms IS NULL OR attempted_at_ms > 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  -- A staff reply is never delivered; only a players reply can be pending, delivered or failed.
  CONSTRAINT tcg_evidence_replies_staff_recorded CHECK ((audience = 'staff') = (status = 'recorded')),
  -- A delivered reply names its Discord message, and nothing else does.
  CONSTRAINT tcg_evidence_replies_delivered_has_message CHECK ((status = 'delivered') = (discord_message_id IS NOT NULL)),
  CONSTRAINT tcg_evidence_replies_error_only_failed CHECK (delivery_error IS NULL OR status = 'failed')
);
CREATE INDEX IF NOT EXISTS tcg_evidence_replies_match_idx
  ON public.tcg_evidence_replies (event_id, match_id, created_at_ms, id);
