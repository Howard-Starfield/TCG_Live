# Private signup and roster

13 October 2026. Approved scope: build signup and roster; keep the organizer separate from players.

## First slice

Reuse the existing private signup/check-in channel, canonical sticky panel, event transaction and audit. Open signup has four slots with Join and Withdraw. The organizer can remove a roster entry while signup is open, close signup when all four slots are filled, or reopen before the round is published. Closing assigns signup order to the existing A–D practice positions and opens attendance check-in. Every assigned player must check in before the organizer publishes. This order is a practice fixture arrangement, not tournament seeding.

The assigned identities live in the event aggregate. A tagged signup session records the installation and separate admin without preset player IDs; a single resolver reads assigned players from the aggregate. Existing fixed-roster rehearsal sessions remain supported. Signup uses aggregate schema version 2 so an older reader cannot silently discard the roster. The database schema stays at version 2.

Reopening retains the roster and audit history, clears attendance and assignment, and requires an unpublished round with all matches still in setup. Signup modes reject preset player environment variables. Stale signup controls are rejected after closure. Routine roster mentions do not ping players. Match panels stay in their configured voice-channel chats and show no player identities before assignment.

No additional signup tables, pairing engine, waitlist, automatic permission changes, dashboard or multiple rounds are included. Existing private channel permissions define who can reach signup.

## Independent review

Claude Opus 5.5, high effort, inspected the plan before coding using a tools-disabled call. The local review is `.local/private-discord-live/signup-opus-review.json`. It requested one authoritative assignment, a tagged session identity, explicit rejection of preset player variables in signup mode, and protection against older readers. All four were accepted. Its small admin-remove suggestion was accepted to avoid a full roster becoming stuck when someone leaves.

The review initially called the plan not ready. The revised design above resolves those blockers; its review is not runtime proof.

## Validation boundary

Offline tests and native PostgreSQL tests cover four-player assignment, concurrency, restart preservation, attendance, stale controls and legacy compatibility. With two real accounts and a separate admin, the live gate can cover one player's Join/Withdraw and organizer denial/closure errors. Four real players plus an admin are still required to verify the complete real signup-to-match flow. Synthetic identities must not be inserted into the live signup roster.
