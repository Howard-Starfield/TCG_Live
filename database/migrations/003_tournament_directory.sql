-- Additive metadata only. The rehearsal session remains the sole source of active/retired state.
CREATE TABLE public.tcg_tournament_directory (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  game text NOT NULL CHECK (game IN ('one-piece', 'one-punch-man', 'pokemon')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, search_text || ' draft')) STORED
);

CREATE INDEX tcg_tournament_directory_search_gin
  ON public.tcg_tournament_directory USING gin (search_vector);
CREATE INDEX tcg_tournament_directory_created_idx
  ON public.tcg_tournament_directory (created_at_ms DESC, id DESC);
