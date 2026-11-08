# Launcher and artwork validation — 7–8 November 2026

## Automated checks

- Supported Node 24.22.1: server/web typechecks and production builds passed.
- **4 core, 218 server, 353 web and 13 launcher/bootstrap tests passed: 588 total.** Four opt-in native PostgreSQL cases were skipped by the ordinary suite. They and the 112 demo-browser baseline passed in the earlier rehearsal; those suites were not repeated for this slice.
- Launcher cases cover instance authentication, unknown occupied ports, concurrent first/repeated/stale launches, build failure release, runtime selection, explicit headless mode, shared initial/repeated browser-opening claims and bootstrap signal handling.
- Persistent guided sessions survive simulated old idle/absolute deadlines; timed modes, logout and access checks remain covered.
- Artwork tests cover persistence, game isolation, missing-file fallback, rejected type/truncation/size inputs, reset, malformed-profile preservation/fallback, card banner selection and attachment ownership. The shared modal's nested scroll-lock cleanup passed.
- npm audit reports **zero known vulnerabilities** after selecting image-size 2.1.0 and compatible HTTP dependency patches. Platform metadata for unchanged lockfile entries was retained.

## Actual Windows launcher

The first native test exposed a Windows PowerShell crash before script execution. The launcher was changed to use a Node bootstrap and has no PowerShell dependency. It discovers a compatible Node/npm rather than requiring a globally upgraded Node installation.

- The actual `.bat` selected the compatible cached Node 24.22.1, built once, started the saved event and opened the default browser. An authenticated dashboard stream was observed after the opening cooldown, proving automatic fragment login.
- Repeating the actual batch file returned Already open. The verified owner PID and built web-index timestamp were unchanged; no rebuild or new browser-opening action occurred.
- A stale dead owner's record was recovered during a subsequent native launch, with a new authenticated owner. No unrelated PID was killed.
- After the bootstrap signal fix, Ctrl+C ended the process and removed its ownership record. The dashboard port was released.
- A separate real discovery-login test intentionally occupied its bootstrap port and omitted database configuration. Guided startup rejected the bind and exited normally before the watchdog deadline, proving the discovery connection was drained rather than left untracked. This did not prepare an event or write roster/audit data.

## Actual dashboard and Discord artwork

- The real dashboard reported persistent sessions with both expiry fields null, artwork controls available, gateway/database ready and the database lease held.
- All three supplied defaults previewed in the real browser. Custom Pokémon banner and thumbnail uploads were saved through the UI; other game settings stayed unchanged.
- A fake GIF returned HTTP 400 and a useful error, preserving both custom selections. The custom selection survived a native process restart.
- An explicit UI Refresh delivered the custom banner to signup and custom thumbnail to both match voice chats. All three canonical message IDs stayed unchanged. A second Refresh retained the exact same Discord upload IDs, proving unchanged files were reused.
- Restoring packaged GIF and state-thumbnail defaults through the UI delivered the packaged Pokémon banner and original match thumbnails. Clearing active-game selection restored the original signup state artwork. No mention was sent by these edits.
- Artwork was visually checked at desktop and 390px viewport widths. The modal fits the viewport, locks background scrolling, traps keyboard focus and keeps its footer accessible; original page overflow styles return on close. Screenshots are local ignored artifacts.

The final selection is original status artwork; the three packaged game defaults remain available for the organizer to select. Temporary custom upload versions remain in the ignored local upload folder within its 64 MiB budget.

## Preservation and review limits

The same active event stayed signup-open at version 8 with an empty roster, three canonical cards and frozen private-room mode. Hash checks preserved all **41 events and 408 audit rows**. No fake players, event replacement, public-room activation or rating changes were used for these checks.

The requested Opus 5.5 high-effort inspection was attempted but the local Claude CLI was logged out. No successful Opus review is claimed. Primary source review and Luna's independent launcher/artwork inspections were completed; concrete cleanup, opening-race and modal issues were corrected and rechecked.

Actual native browser-closed reopening and an overnight idle check remain manual return cases; automated tests cover the corresponding rules. PNG/JPEG and animation-disabled real-client checks are also retained. Four real players plus a separate organizer are still required for the full match rehearsal; only the organizer and one player are available. See `RETURN_TEST_LIST.md`.
