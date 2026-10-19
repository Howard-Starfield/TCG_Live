# Signup and roster validation

13 October 2026. Implementation follows [the reviewed plan](SIGNUP_ROSTER_PLAN.md). The organizer remains separate from the four players.

## Verified

- TypeScript typecheck passed. The complete offline suite passed 53 tests; its two opt-in database cases were intentionally skipped.
- Both opt-in native PostgreSQL cases passed with no skips. Signup assertions run sequentially inside the Discord database case, after its legacy session is retired. They cover concurrent joins, duplicate no-op, four-slot capacity, insufficient closure, canonical-card and principal checks, assignment from saved join order, unchanged session identity, reopening and attendance clearing, replacement roster membership, attendance before Publish, denied reopen after publication, and matching audit/version counts.
- The existing 25 event rows and 282 audit rows were individually hashed before testing and matched afterward. New fixtures were added; historical event and audit content was retained.
- Source checks preserve legacy configuration and session JSON without a kind tag. Signup uses a tagged identity without preset players, an aggregate schema version 2 and one assignment resolver. Frozen admin conflicts are rejected on read. Current tests reject v1 data carrying signup; the previous reader's explicit `schemaVersion !== 1` check would reject the new v2 aggregate.
- Actual Discord Gateway login and REST panel creation succeeded on the authorized private guild. The named `/tcg-test` command was updated without bulk command replacement. Signup is pinned in `tcg-two-player-test`; M1 and M2 panels are in their assigned voice-channel chats. Signup showed 0/4 with Join/Withdraw. Both match panels showed Awaiting signup with disabled readiness.
- Three superseded, exact bot-authored panels from the retired two-account rehearsal were removed after the new panels were verified. User messages and historical event/audit rows were retained.
- The live signup runtime reported ready, its local `/readyz` returned ready, and its error log was empty at startup. The roster was empty; no fake C/D accounts were seeded.

Task-local evidence is under ignored `.local/private-discord-live/`: `signup-opus-review.json`, `signup-before.json`, `signup-live-verification.json` and runtime logs. The live event at startup was `d5c8f55b-6a28-4a2b-a08f-7ee52354aeb7`. Logs and snapshots are verification evidence, not configuration to copy into production.

## Pending human checks

The user reported that signup works and confirmed the organizer receives “Signup admin cannot play.” A subsequent database read showed signup still open, no admin in the roster, event version 4, no attendance and no publication. The runtime error log was empty. The roster was empty at that read; the individual click sequence and a new sticky replacement were not independently verified. Error-message cleanup and existing sticky behavior have regression coverage and prior live evidence. A real human post during signup still needs explicit confirmation.

Two available accounts mean one separate organizer and one actual signup player. The full real flow requires four players plus the organizer: close signup, four attendance check-ins, publish, assigned voice-chat access and the existing match buttons. Native database tests establish the four-member state flow; they do not establish four-human Discord acceptance. See [the future checklist](FUTURE_TEST_CHECKLIST.md).
