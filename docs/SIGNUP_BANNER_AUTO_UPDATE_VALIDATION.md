# Signup banner automatic update validation

Verified 8 November 2026 against the existing private Discord rehearsal and the built dashboard.

- The current artwork profile had no active game, so the signup panel still used generic status artwork. Selected Pokémon through the new Edit signup banner control; the existing Discord signup message immediately received pokemon-tournament.gif without using Refresh panels.
- Uploaded the same supplied GIF through Choose banner image. The dashboard reported applied and Discord received the content-hash custom banner. Update signup banner retained the same CDN upload ID. Restore packaged GIF immediately restored the packaged banner. Pokémon remains selected.
- All three canonical message IDs stayed unchanged. Match status images were retained, and message mentions remained empty. All 41 event aggregates and 408 audit rows matched the pre-change baseline; active event version 8 and empty roster were preserved.
- Controller coverage verifies edit-only delivery, missing/suspended panel handling, no rebinds or new sends and no state mutation. Routes cover active/inactive edits and saved-but-pending failures; transient status is absent from GET. Independent source review found no blocker.
- Typechecks, full ordinary test suites and production web build passed. Four opt-in database cases were skipped by the ordinary suite. Focused final routes/controller tests passed 24/24 after the additional pending coverage.
- Browser preview decoded successfully and the dialog was visually inspected. Evidence: output/playwright/banner-auto-final.png (local, ignored).

## Return checks

- From a real Discord account, post in the signup channel and confirm the sticky replacement retains the Pokémon banner and working signup controls. Existing sticky logic was unchanged; this human-triggered check was not repeated in this slice.
- Confirm animation in the user's Discord client; reduced-motion/autoplay preferences may show a still frame. Native PNG/JPEG display and four-player gameplay remain on the existing test list.

Runtime artwork settings, uploads, credentials and logs remain ignored. No database schema or tournament rules changed. The bot remains online.
