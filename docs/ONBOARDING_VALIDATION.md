# Guided startup validation — 7 November 2026

## Real installation

The guided launcher was run against BoBoAssist in sdokdyg's server with the existing active signup event. Its environment supplied the already-selected local rehearsal database; the launcher loaded the existing token from the ignored root `.env`. No preset guild, channel or player configuration was passed by the live helper.

- First-run authenticated setup displayed the actual server and discovered text/voice channel names.
- Existing event `d5c8f55b-6a28-4a2b-a08f-7ee52354aeb7` prefilled and locked the organizer, signup channel, match rooms and private mode.
- All three selected channels reported Ready. A fresh forced role/channel check confirmed Manage Permissions is now available in both match rooms. The previous permission warning in the earlier rehearsal record is historical.
- Check readiness posted a bot-owned green setup status in the assigned signup channel without mentioning anyone. Its saved message ID is `1568860278299435160`.
- Save and Start opened a new authenticated normal dashboard session. The actual gateway and database reported ready, the database lease was held, and the same event remained signup-open at version 8 with no players and three saved panel IDs.
- An incomplete signup-close request returned 422 without changing the event or audit. An unauthenticated status request returned 401. Retired history remained readable.
- Hash comparison against the pre-start snapshot preserved all **41 events and 408 audit rows**, with no new event, fake player or audit write.
- Readiness was visually inspected at desktop and 390px viewport widths; no horizontal overflow occurred. Screenshots are local ignored verification artifacts.
- A controlled separate connection held the existing advisory lease during a subsequent guided start. Live startup failed safely and opened a new authenticated setup page with the recovery explanation and unchanged locked event. After releasing that connection, the real wizard's Recheck / Save and Start resumed successfully. The guide retained its original message ID without a new mention; the same 41-event / 408-audit hash comparison passed again. The bot finished online.

The active event retains its frozen private-room mode. Granting permissions does not silently change an existing event to public rooms.

## Assets and queue

All three supplied GIFs were copied unchanged to the per-game source asset folders and SHA-256 matched to the originals. Thumbnail folders are placeholders. Dashboard upload/preview/reset controls and per-game runtime switching remain queued in `GAME_VISUALS_QUEUE.md`.

## Remaining human checks

The four-player rehearsal remains blocked on additional real player accounts; only the organizer and one player are available. No four-human signup, placement or completed-round proof is claimed. Native default-browser opening and a fresh real-server event using the wizard remain separate manual checks; the live validation resumed the existing event deliberately.

## Review

The requested local Claude Opus inspection was attempted before implementation but returned Not logged in. It is not recorded as a successful review. Primary source review and Luna's independent inspection identified and addressed active-session compatibility and handover recovery cases.

## Automated checks

- `typecheck:all` and server/web production builds passed using Node 24.22.1, within the supported 24.x range.
- `test:all`: **4 core, 213 server and 352 web tests passed**. Four opt-in native database cases were skipped by the ordinary suite.
- New coverage exercises authenticated setup routes and Host/Origin checks, profile validation and ambiguous sends, frozen signup/legacy/shared-chat resume, failed handover recovery, concurrent Finish, missing prerequisites, invalid channel types/AFK routing, fresh permission discovery, guide plaintext fallback/ownership/attachment retention, and the dashboard wizard.
- The existing native database and 112 demo-browser checks passed in the earlier rehearsal baseline. They were not rerun for this slice; the new live wizard checks and unchanged-history hash comparison above provide the current installation proof.
