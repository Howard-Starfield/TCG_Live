# Admin Tournament Rules

Updated: 2026-10-10

**Status: agreed product rules for the planned Discord bot. This guide does not claim these features are implemented.** Detailed decisions, history, and research are in the [decision log](TCG_BOT_DECISIONS.md).

## The three rules to remember

1. **An expired match clock calls for a judge. It NEVER automatically awards a win or a draw.**
2. **Camera/SIM setup has no time limit.** Each match starts only when both players confirm readiness.
3. **A pairing bye and a no-show forfeit are different.** A bye fills an odd-player pairing gap; a judge handles an absent assigned opponent.

## 1. Create the tournament

The organizer sets the event rules. Players follow those rules and manually check their opponent and camera/SIM setup; the bot does not verify those for them.

| Setting | Agreed behavior |
| --- | --- |
| Tournament format | Swiss by default; pair similar tournament records/points, not ELO |
| Swiss round count | Auto from checked-in attendance; manual dropdown available before start |
| Round-count lock | Lock when round one starts; late admissions do not change it |
| Match format | BO1 by default; admin may select BO3 |
| Match time | BO1: 30 minutes; One Piece BO3: 60; Pokémon BO3: 50; durations editable |
| Swiss finish | Admin chooses STANDINGS or PLAYOFFS; detailed playoff rules remain open |
| Next-round release | Automatic once all required results are final; optional organizer-click mode |
| Reminder | DM 10 minutes before scheduled tournament start by default; configurable at creation |
| Entry and rewards | Free entry for now; Reward is display text, with no payment or fulfillment system |

**Scoring defaults, all editable:** match win 3, draw 1, loss 0; game/set win 0, game/set tie 0; pairing bye 3. A BO3 score of 2–0 or 2–1 is one match win. The alternative 1 / 0.5 scoring question has not changed these defaults.

## 2. Check players in and start round one

- Use the pinned tournament-channel check-in message as the single check-in location.
- DM reminders link to that message. Players can still check in if DMs are blocked or unavailable.
- Each player receives a private acknowledgment. Repeated clicks never count them twice.
- Both the check-in message and reminder show a live countdown to the **scheduled tournament start**.
- Attendance check-in closes when round one starts. The round count locks at the same point.
- The scheduled-start countdown does not start table matches or impose a camera/SIM setup deadline.

**Late arrival:** an admin may use **Late check-in** to admit the player to the next unpaired Swiss round. Preserve existing matches, created pairings, and the locked number of rounds.

## 3. Pairing byes: when and who

An odd active-player count before pairing leaves one player without an opponent. Assign one pairing bye; do not add a round.

Selection order:

1. Choose eligible players with the **fewest previous pairing byes**.
2. Choose the **lowest tournament points** within that group.
3. If still tied, choose randomly.
4. Record the bye, award the configured bye points (default 3), and leave ELO unchanged.

**Why:** fewest prior pairing byes gives players with zero byes priority and distributes repeats fairly when needed. Points determine priority within that group; random choice resolves the final tie. One rule covers both first and repeat byes, without extra settings or admin screens.

**Example:** 101 active players produce 50 matches and one pairing bye. Ava and Ben both have 0 points and no prior pairing bye; Chen has 0 points but already received one. Choose randomly between Ava and Ben. Chen is excluded from that selection even though all three have equal points.

**Repeat-bye example:** if everyone has already had a pairing bye, use the same sequence. A player with one prior pairing bye has priority over a player with two, regardless of points. Among players with the fewest prior byes, choose the lowest points, then randomly if still tied. No-show forfeits do not count toward these bye totals.

## 4. No-shows: an admin decision

If an opponent was assigned but does not attend, use **Call judge**. An admin reviews the situation and may award a forfeit/result. There is no automatic penalty or separate complicated no-show workflow.

**Example:** Dana is paired with Eli, who never arrives. A judge may award Dana a forfeit win. This is not Dana's pairing bye, so it does not consume bye eligibility. A later justified forfeit win is not blocked by an earlier forfeit.

**Important:** no-show/forfeit ELO treatment is still undecided. The proposal is normal configured win points with both players' ELO unchanged because no game was played; it awaits approval. Do not copy the pairing-bye no-ELO rule onto forfeits.

**Missed rounds before late admission:** award 0 tournament points, label each **Missed round**, and make no ELO change. Do not record these as played losses.

## 5. Run each match

The shared match card lives in the voice/video channel's chat.

- Players manually verify the opponent and setup.
- Both click **Confirm Ready** before the match clock begins.
- Setup is unlimited. An unready table may delay round completion.
- Use **one clock for the whole match**. Do not restart it between BO3 games.
- Either player can **Pause** immediately, freezing remaining time.
- Both must click **Resume** to continue; a judge may override.
- A judge may grant an extension.
- At expiry, flag a judge. **Never infer a winner, draw, or automatic penalty.**

The bot cannot physically stop players from playing early in an external simulator. A displayed countdown also does not replace the bot's stored remaining-time and pause state.

## 6. Report, confirm, or dispute a result

The initial card offers **I won**, **I lost**, **Call judge**, and **Pause**.

1. Either player reports the result.
2. Update the same card to name the proposed winner.
3. Only the opponent may choose **Confirm result** or **Dispute result**. The reporter cannot confirm their own report.
4. Opponent confirmation finalizes immediately. An admin may also finalize.

A dispute can still be settled by the players while they wait for a judge:

- Confirm the existing proposal to finalize it and close the dispute.
- If the result changes, make a fresh proposal and have the other player confirm it.
- An admin may resolve or correct the result directly.
- Update the staff queue after resolution so stale actions cannot repeat it.

Admins may correct finalized results. Recalculate affected ELO without double-counting. If a correction affects a downstream match already started, flag it for organizer resolution; **never automatically replace a player mid-match**.

## 7. Release rounds and finish

The default is to publish the next round automatically when every required match result is final. An organizer may choose manual release instead. Open disputes and correction holds block release; an unconfirmed report or expired timer is not a final result.

The admin chooses the Swiss finish:

- **STANDINGS:** rank by tournament points, then the ordered tiebreakers.
- **PLAYOFFS:** continue into a playoff stage after Swiss.

The exact tiebreakers and playoff details remain open. Do not repeatedly apply identical exhausted tiebreakers and claim they break an exact tie. A tie-only deciding playoff is a proposal awaiting approval.

## 8. Points, ratings, and records

- Tournament points belong to one event. Start each new event at zero.
- ELO persists across events. Played results update it against expected outcome, using a formula still to be selected.
- Pairing byes and missed rounds do not change ELO.
- Log reports, confirmations, disputes, corrections, pauses, resumes, bye assignments, and admin actions.
- Archive results, standings, participant/member lists, and audit history in the database for future lookup. Starting points at zero does not delete prior records.

## 9. Still to decide

Do not treat these as implemented rules or silently choose defaults:

- Exact Auto attendance-to-round-count table, limits, and alternate event profiles.
- ELO treatment of no-show forfeits.
- Ordered tiebreakers and the final fallback for an exact first-place tie.
- Playoff cut sizes, bracket/qualification rules, and explicit finish-selector default.
- ELO starting rating, formula, K factor, and initial seeding policy.
- Rematch fallback; detailed handling of corrected standings and already-created pairings.
- Remaining registration/authentication, room/privacy, and control/countdown UI details.

The earlier standings-based default has not been explicitly revoked; approval of both finish modes did not newly choose a selector default. Native Discord relative timestamps are a possible countdown display, not a guaranteed second-by-second stopwatch.

## Quick division of responsibility

**Planned bot responsibilities:** track check-in once per player, display reminders/cards/countdowns, apply configured pairings and scoring, enforce button permissions/readiness, preserve pause state, record actions, block unresolved progression, and archive event records.

**Admin/judge responsibilities:** set the event rules, admit late players at discretion, handle no-shows and expired clocks, grant extensions/overrides, resolve or correct results, and handle corrections affecting matches already underway. Settle the open policies above before relying on them.
