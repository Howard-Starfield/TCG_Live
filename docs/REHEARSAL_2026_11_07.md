# Rehearsal verification — 7 November 2026

Synced this checkout by fast-forwarding `main` from `8036176` to `66b092d`, including the merged local admin console. The user confirmed that only two real Discord accounts are currently available, with the owner remaining the separate organizer. A complete four-human match is therefore still pending.

## Setup correction

The advertised Node 24.14.0 failed `npm ci` with `EBADENGINE`: locked dashboard dependencies require Node 24.15.0 or newer in the 24.x series. Corrected `.nvmrc`, root package/lock engine metadata and the README minimum to 24.15.0. No dependency versions changed. Installation and verification used the already-installed bundled Node 24.22.1 and npm 11.9.0; no system Node installation was changed.

The attempted Claude Opus plan check was unavailable because its CLI was not signed in. The bounded four-line metadata correction was implemented by Sol and its diff reviewed by the primary agent; no successful Opus review is claimed for this correction.

## Automated results

| Check | Result |
| --- | --- |
| Clean dependency install with compatible Node | Passed |
| Server/core and web typechecks | Passed |
| Shared-rule tests | 4 passed |
| Server tests | 200 passed; 4 opt-in PostgreSQL cases skipped here |
| Web tests | 348 passed in 31 files |
| Existing browser suite against the demo runtime | 112 passed, no skips, in 4.4 minutes |
| Native PostgreSQL suite, including admin reads and commands | 4 passed, no skips |

Browser checks covered the simulated four-player signup/check-in/match flow, admin commands, results/corrections, conflicts, history, accessibility, login/security and real Windows console-control shutdown. These are demo-runtime browser checks, not four real Discord players.

Before native tests, the stopped task-owned live session was temporarily retired under the existing advisory lock. Afterward the exact saved session was restored. All 33 pre-existing event rows and 356 audit rows matched their pre-test hashes. The native suite added eight separate synthetic fixture events and 48 audit entries; it did not reset historical data. Subsequent real player clicks are expected to change the active event and append audit entries.

## Real Discord + database + console

Started the actual Discord runtime with the localhost console and admin actions explicitly enabled, using the existing saved private signup event. Opened the production-built console in a separate Chrome session through its private launch link. Credentials were not printed in verification output; local login artifacts, snapshots and screenshots are excluded from Git.

Verified against the running production adapter:

- Gateway ready, PostgreSQL ready, database ownership lease held and live console stream connected.
- Three saved Discord cards bound; the active signup and retired history are readable through the authenticated API.
- The real console's Refresh panels action succeeded and displayed its success notice.
- Closing the incomplete signup through the real console API returned HTTP 422 with the four-player rule. Event version and audit remained unchanged by the refused command.
- An unauthenticated status request returned HTTP 401.
- The signed-in console showed the active roster, historical Discord activity and live data without a reload. A screenshot was captured locally under `output/playwright/`.

## Human interaction follow-up

The user's test passes produced two authenticated Join/Withdraw cycles for the real player account, advancing the active event from version 4 to 8. No fake accounts were inserted. The browser console showed 1/4 joined after the rejoin and returned to 0/4 after the final Withdraw, through the existing live stream without a reload. The final saved roster is empty; no check-ins or publication occurred.

A normal message from that player triggered a new canonical signup panel 4,343 ms later. The new panel was pinned, contained its visual, and was the latest channel message. Discord returned Unknown Message for the original canonical card, confirming its removal. This verifies signup sticky reposting with a real human message in this run; it does not replace the still-pending four-player voice-room tests.

## Remaining gates

The live permission validator still reported missing Manage Roles in both match voice rooms during this run's recorded preflight. The user said they would grant it; that statement alone is not proof of the permission change. Public-room mode remained off pending a successful permission check. No public permission replacement or automatic voice movement is claimed here.

With only one player plus the separate organizer, four-member signup Close, four real attendance check-ins, Publish, pair-only voice chat and actual player placement cannot all be proven live. Those remain in [the return test list](RETURN_TEST_LIST.md). The successful native/demo tests do not remove that acceptance gate.

Ignored task evidence is under `.local/private-discord-live/` (`nov07-before.json`, runtime logs, human/sticky verification and private login artifacts) and `output/playwright/`. Source prerequisites and this record contain no credentials.
