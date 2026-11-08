# Sidebar search and tournament drafts

## Requested behavior

Keep the existing dashboard styling. The left event list gets a visible scrollbar thumb with a transparent track. Live and History have independent disclosure buttons: right chevron when collapsed, down when expanded. A fixed search field and inline SVG plus button sit above Live. Tournament names occupy the main line; dates move to the existing small muted secondary text.

The user chose **save a draft, then start it later**. Creating a draft must not retire, replace or start the current Discord event. The form chooses a game, defaults the name to that game's tournament label and preserves a manually edited name when the game changes. A successful create selects the saved draft and shows its name in the sidebar. Draft detail displays saved metadata and draft status rather than a fabricated match snapshot or live command controls.

## Bounded implementation

Add a separate PostgreSQL tournament-directory metadata table with UUID, name, selected game, creation time and indexed full-text search data. A draft has no Discord session or gameplay aggregate yet. Existing session-backed events are merged into the directory as Live/History, with existing kind-based fallback names. Keep the one-active-session invariant and gameplay schema version 2 unchanged. Actual draft activation is a separate lifecycle step; there is no replacement action hidden in this form.

Use authenticated GET `/api/v1/tournaments?q=…` and UUID-idempotent POST `/api/v1/tournaments/drafts`. Search uses PostgreSQL full-text prefix matching with normalized safe query tokens, including accented Pokémon names and game labels. Do not introduce another search engine. Preserve existing read/history/command endpoints. A session feature marker exposes the plus/search API only where mounted; demo retains its existing event source.

The additive directory migration is explicit and repeatable. Recognized base/Discord setup must continue accepting the exact known schema with this new table, while unrelated public-schema objects remain refused. Missing migration produces a clear setup message instead of preventing the bot from starting. Draft creation checks the running process's lease and never writes event state, roster, ratings, canonical Discord IDs or audit history.

## Verification

Check scrollbar appearance, both disclosure directions/keyboard behavior, small date typography, search across drafts and history, custom/default names, game changes, pending/error/retry behavior, UUID idempotence and stale-search response handling. Selecting a draft must not fetch a match snapshot or expose live-event actions. Verify actual PostgreSQL migration, FTS, persistence and same-ID conflicts in the selected rehearsal database; remove only generated QA draft rows. Compare existing event/audit hashes and canonical messages before and after. Inspect the real dashboard at desktop and narrow widths, run relevant tests and retain remaining human checks.
