# Admin Tournament Rules

Updated: 2026-10-10

**Status: planning only. The user explicitly asked not to build yet. These agreed product rules do not claim implementation or authorize installation/deployment.** Detailed decisions, history, and research are in the [decision log](TCG_BOT_DECISIONS.md).

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

### Hosting plan

- Use **TypeScript**, with the bot and admin website/API on the user's personal PC.
- Admin/API access is **localhost only**, not LAN/public. The bot connects outward to the Discord Gateway.
- No tunnel or router port forwarding now. Remote admin and public match browsing are future work; keep the API portable.
- The public website remains a disconnected mockup.
- Run **PostgreSQL on the same PC**. Keep code/configuration, live database data, and local exports under one organized project folder.
- Never commit or publish secrets, live data, dumps/exports, or logs.
- Use **pg_dump / pg_restore** for safe database moves, not a copy of a live database directory. Compatible runtime dependencies are still needed; portability does not make the folder self-running.
- An off-PC backup copy is desired, but no destination or backup setup is configured.
- **Native Node.js and PostgreSQL are selected**, replacing Docker Compose. Keep PostgreSQL data in project-local PGDATA. Compatible native runtimes must be installed separately on the destination PC; this documentation does not authorize installation.
- The bot should prevent PC sleep while running. Proposed implementation: a temporary keep-awake request that releases on exit while allowing the display to turn off. These implementation details remain proposed; no system power settings have been changed.
- Folder layout: `apps/server` combines bot/API/scheduler; `apps/web` holds the local admin; `packages/core` holds shared rules; `database/migrations`, `data/postgres`, `backups`, `scripts`, and `docs` keep supporting files organized.
- Export/restore scripts provide the normal move-to-another-PC workflow. Use placeholder configuration in Git and supply private settings locally.
- These are planning choices, not permission to install, deploy, or provision anything.

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

**Unplayed no-show forfeits:** award the normal configured tournament win points and leave both players' ELO unchanged. A normal concession in a played match remains rated.

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

### If the final standings are exactly tied

Apply all selected numerical tiebreakers first; their exact order/formulas still need a decision. If the players remain exactly tied:

- **Champion or final playoff qualification spot:** flag the organizer and arrange a deciding match/playoff among those tied players. Leave the affected outcome unresolved until the deciding result is confirmed.
- **Exactly two players:** an extra deciding match is acceptable and is the simplest approach.
- **More than two:** use a tie-only playoff; its detailed format is still to be decided.
- **Lower placements only:** allow a shared rank.

Never silently use ELO, registration order, or a random draw to choose the winner/qualifier. Random selection for pairing byes is a separate rule.

The deciding match still uses the judge/result workflow: an expired clock flags a judge and **never automatically determines a winner or draw**. Its format, duration, drawn-result handling, and ELO/points effects remain open; do not invent them.

## 8. Points, ratings, and records

- Tournament points belong to one event. Start each new event at zero.
- Each player has **separate persistent ELO per game**; One Piece and Pokémon ratings stay independent. Tournament points remain separate and reset each event.
- **CAM and SIM initially share a game's rating**. Store and show the mode on every match/result so admins can review mode-specific abuse.
- Start at **1200**, using standard logistic ELO with **fixed K=32**. Update once per whole confirmed match, including BO3; keep fractional ratings internally and round for display.
- Played matches and normal played concessions are rated. Unplayed no-show forfeits award configured tournament win points with no ELO change for either player.
- Pairing byes and missed rounds do not change ELO.
- Log reports, confirmations, disputes, corrections, pauses, resumes, bye assignments, and admin actions.
- Archive results, standings, participant/member lists, and audit history in the database for future lookup. Starting points at zero does not delete prior records.

### Admin corrections and mode-specific review

Show CAM/SIM on each record so an admin can trace mode-specific abuse. Admin actions are **correcting and voiding results only for now**, without a disqualification/suspension system. Record the reason and mode; preserve the original record and history. Adjust affected points and recalculate/replay ELO without double-counting. If a downstream match has started, use organizer review and never automatically replace a player.

### Database health and recovery page

The localhost admin website includes a **Database page** with a robust backup/recovery toolkit:

- Health, storage usage, and domain-record counts.
- Backup history, last successful backup, and restore-test status.
- Guided recovery that preserves original data and asks for confirmation before switching to a restored database.
- A maintenance/recovery view that remains available when PostgreSQL is down, using required metadata stored outside PostgreSQL. Mark unavailable statistics honestly.
- Privileged recovery available only through the local admin path, separated from the application's least-privilege database access.

**Backup timing:** a configurable five-minute interval while a tournament is active, plus a backup before database upgrades. Test the overhead and never overlap backup jobs.

**Recovery-point warning:** display the actual last successful snapshot time, dump duration, and any failed jobs. A five-minute schedule does not guarantee at most five minutes of lost data; slow or failed backups can widen that window.

**Retention, all editable:** keep each frequent backup for 24 hours, daily backups for 30 days, and retain pre-upgrade backups. Protect the latest successfully test-restored backup from automatic cleanup.

This means a new backup roughly every five minutes **only during an active tournament**. Each frequent copy stays for 24 hours before becoming eligible for cleanup; it does not mean frequent backups run all day without an active event. A four-hour event produces about 48 copies, subject to timing and successful jobs. V1 uses full database exports, so show total backup storage and editable settings.

The off-PC destination and detailed safety procedures remain open. No backups, cleanup, or restore tests have been performed by this documentation work.

**Safety-review proposals:** recovery metadata/authentication must work during a database outage; use separate maintenance credentials; restore fresh and preserve the original; serialize recovery, block all mutation entry points and drain in-flight work, then reconcile Discord before writes resume. Keep connection-health checks, checksum checks, and restore tests clearly separate. These are proposed safeguards, not claims of completed implementation.

### Local backup copies and cloud status

Documents is **not cloud-synced yet**. Keeping one project copy and one verified Documents copy is now confirmed.

**Confirmed layout:** finish one export in `TCG_Live/backups`, then make and verify a copy in `Documents/TCG_Live Backups`. Apply the agreed retention/protection rules to both sets and exclude backups from Git. The workflow and paths are approved; checksum/copy mechanics have not been implemented.

Show **local-only** status until cloud synchronization is actually verified. Two copies on one PC do not protect against losing that PC; copies on one drive also share its failure risk. No cloud setup, upload, or backup copy has been performed here.

## 9. Still to decide

Do not treat these as implemented rules or silently choose defaults:

- Exact Auto attendance-to-round-count table, limits, and alternate event profiles.
- Ordered numerical tiebreakers and formulas.
- Detailed tie-only playoff format, BO1/BO3, duration, drawn deciding-match handling, and ELO/points effects. Organizer-arranged deciding play for exact champion/final-qualification ties and shared lower ranks are confirmed.
- Playoff cut sizes, bracket/qualification rules, and explicit finish-selector default.
- Initial ELO-based seeding policy; the 1200 starting value and logistic K=32 calculation are approved.
- Scoped keep-awake implementation and detailed recovery safety procedures; native runtime and the toolkit/page scope are selected.
- PostgreSQL schema, provisioning, and implementation details.
- An off-PC destination and remaining verification/retention implementation details, including how long pre-upgrade backups are kept. Project/Documents paths and the verified-copy workflow are confirmed; both copies are local-only while Documents is unsynced. Frequent backups: 24 hours; daily backups: 30 days; latest successfully test-restored backup: protected. Settings are editable.
- Implementation details for correction/voiding and replay of dependent ratings. Disqualification and suspension are outside the current scope.
- Rematch fallback; detailed handling of corrected standings and already-created pairings.
- Remaining registration/authentication, room/privacy, and control/countdown UI details.

The earlier standings-based default has not been explicitly revoked; approval of both finish modes did not newly choose a selector default. Native Discord relative timestamps are a possible countdown display, not a guaranteed second-by-second stopwatch.

## Quick division of responsibility

**Planned bot responsibilities:** track check-in once per player, display reminders/cards/countdowns, apply configured pairings and scoring, enforce button permissions/readiness, preserve pause state, record actions, block unresolved progression, and archive event records.

**Admin/judge responsibilities:** set the event rules, admit late players at discretion, handle no-shows and expired clocks, grant extensions/overrides, resolve or correct results, and handle corrections affecting matches already underway. Settle the open policies above before relying on them.

## Rating and storage reference

1200 and K=32 are selected launch settings, not an official TCG requirement. See the [exact formula and sources](TCG_BOT_DECISIONS.md#rating-and-database-references). PostgreSQL is the selected technology; no database has been provisioned by this documentation task.

