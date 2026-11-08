# Tournament details and compact signup validation

Verified 8 November 2026 in the private rehearsal. The current test is explicitly saved as Pokemon Test Tournament (with the accented game label in the UI), with Pokemon as its game and a short signup rehearsal description. Previously only the artwork profile selected Pokemon; the event had no saved game metadata.

## Delivered

- Edit tournament details saves the live event title, explicit game and optional plain-text description. Saving selects matching game artwork and edits existing Discord panels. Failed display updates report saved/pending; retrying does not create cards.
- Metadata uses the existing tournament directory keyed by the real session ID. Additive migration 004 adds description; the directory setup command applies it to new and existing installations. Internal fixture game/rules, roster, clocks and audit remain unchanged.
- Signup panels show the saved title/game/description, fixed test format and player counts. Public roster names and assignments are removed. Open signup buttons are Join, Withdraw, View roster in that order. Roster remains available during check-in and after publication.
- View roster checks the canonical event/channel/message and responds privately without a domain command or panel edit. Existing private response cleanup applies after approximately eight seconds. A spectator can read the roster; joining/admin restrictions are unchanged.

## Evidence

- Typechecks passed. Server suite: 227 passed, four opt-in database cases skipped. Dashboard command suite: 32 passed; full web suite: 359 passed after the accessibility fix. Card tests cover populated roster privacy, metadata rendering and button order; controller tests cover spectator reads, copied-card refusal and no mutation. Route tests cover successful persistence with failed Discord delivery and no apply on rejected saves.
- Native database checks rejected retired-event edits and lost-owner writes without changing active metadata. Applied migration preserved all 41 event aggregates and 408 audit rows.
- Authenticated browser saved test details and reported Discord update applied. The dialog was visually inspected; the sidebar updated to the saved name. Local screenshot: output/playwright/tournament-details-saved.png.
- Discord REST verified the exact existing signup message title, game, description, Pokemon GIF and three buttons. No public roster mentions. All canonical message IDs stayed unchanged; active event version remains 8 with an empty roster. Metadata adds one directory row for the existing active event.

## Return checks

- Click View roster from a real player account: only that account should see the current list, and it should disappear after approximately eight seconds. Check an empty roster, then after joining. Automated controller and adapter coverage passed; this new real-client button click remains unperformed.
- Post a normal message to check sticky replacement retains title/game/description, GIF and button order. Continue existing four-player gameplay and animation-disabled client checks when accounts are available.

The bot remains online. Credentials, runtime profile/uploads and local verification logs are ignored.
