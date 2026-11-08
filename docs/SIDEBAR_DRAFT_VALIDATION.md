# Sidebar and draft validation — 8 November 2026

## Delivered

- Transparent scrollbar track with a visible thumb.
- Separate Live/History disclosure buttons; expanded arrow points down, collapsed points right.
- Fixed search toolbar with an inline SVG plus button.
- Names on the main line and smaller muted creation/retirement dates and times underneath.
- Game-based default names, custom names and persisted signup drafts. Selecting a draft shows metadata rather than the current event's match controls or preview.
- PostgreSQL full-text prefix search over draft names/games/status and existing session history.

The user explicitly selected Save draft. This creates no Discord signup session; activating a saved draft is a separate later lifecycle step.

## Checks

- Server/web typechecks and production builds passed.
- Ordinary suites: **4 core, 220 server, 357 web and 13 launcher tests passed** (594 total), plus the dedicated native directory case. Four existing opt-in gameplay database cases were skipped by the ordinary suite.
- The dedicated native directory database case passed in the selected local rehearsal database. Migration created the additive table and GIN index, repeated setup returned already_ready, both older schema setup commands remained compatible and the gameplay schema marker stayed at 2.
- Actual HTTP checks returned 200 for an identical UUID retry, 409 for a changed payload or active-event ID collision, 403 for a foreign Origin, 401 without authentication and 400 for an oversized name. Unicode name + compact game alias + draft-status search worked. History status search returned the existing 24 retired Discord sessions.
- The real browser verified game-default naming, preserving a custom name across game changes, saving/selecting a draft, multi-word prefix search, reload persistence and returning to the live event. No draft snapshot request, command composer or match preview appeared when viewing a draft.
- Computed scrollbar track was transparent. Actual disclosure rotations were 90 degrees expanded and 0 degrees collapsed. The plus button was vertically aligned with the search input. Name text was 12.5px and secondary metadata 11px using the existing muted color.
- Desktop and 390px create-dialog screenshots were visually inspected. Search validation errors were shown with their safe server message and clearing the search recovered the list; the field caps input at 120 characters. Local screenshots and sanitized HTTP/database evidence are ignored artifacts under output/playwright and .local/private-discord-live.

## Preservation and limits

All generated QA drafts were removed by their exact generated ID/name/game; no user draft was removed. The original **41 event aggregates and 408 audit rows** matched the pre-change hashes, and the same active event remained signup-open at version 8 with an empty roster and unchanged canonical message IDs. The directory lists the existing 25 session-backed events; the other stored local-rehearsal aggregates remain outside the Discord sidebar as before.

The full four-player rehearsal and earlier native gameplay suites were not repeated for this metadata/UI slice. Primary review and Luna's independent source review found no remaining blocker. Draft activation, concurrent live tournaments and changes to game rules were outside this request.
