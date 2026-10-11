# TCG Live Discord Bot: Decision Log

Updated: 2026-10-10  
Status: Planning only. The user explicitly asked not to build yet. This document does not authorize implementation, installation, provisioning, or deployment.

This file records the agreed product behavior, separates unresolved questions from decisions, and keeps research from being mistaken for approval. The latest explicit user decisions take precedence over earlier suggestions.

For the plain-language administrator guide, see [Admin Tournament Rules](ADMIN_TOURNAMENT_RULES.md).

See the [three-reviewer planning debate](PLANNING_DEBATE_REVIEW.md) for counterexamples, resolved technical disagreements, proposed safeguards, and unexecuted acceptance tests. Its recommendations do not approve new policy; numerical tiebreak rules remain pending.

## Critical invariant: expiry requires a judge

**When the match clock expires, the bot flags a judge. It must NEVER automatically assign a winner or a draw.** A judge can resolve the match and grant an extension. Clock expiry is not a result submission, confirmation, or automatic penalty.

## 1. Product scope and interface

- The product is a Discord-native tournament bot with message-based controls.
- The tournament frontend is Discord messages/cards, not a standalone tournament dashboard.
- Entry is free for now.
- A tournament's **Reward** field is display text only. Payment collection, payouts, and reward fulfillment are not in scope.
- Organizer-defined rules are fixed for the event; players do not negotiate or change the tournament rules.
- Players manually verify their opponent and applicable camera/SIM settings. The bot does not automatically verify these.
- The existing public frontend mock is a separate project:
  - Demo: https://tcg-tabletop-command.quintin-rajnauth.chatgpt.site
  - Repository: https://github.com/Howard-Starfield/tcg-discord-frontend
- This decision log belongs to https://github.com/Howard-Starfield/TCG_Live. It does not move, replace, or deploy the mock frontend.

### Tournament check-in and reminder messages (confirmed)

- Use one pinned channel message as the canonical tournament check-in location.
- DM reminders are supplementary and link players to that canonical message. Check-in must work without successful DM delivery or DM access.
- Give each player a private acknowledgment of their check-in.
- Check-in is idempotent: repeat clicks do not count the same player twice.
- **Tournament attendance check-in closes when round one starts.** This does not create a deadline for a table's camera/SIM setup; that setup remains unlimited.
- The default DM reminder lead time is **10 minutes before the scheduled tournament start time**. This replaces the earlier five-minute default.
- Let the organizer/admin configure the reminder lead time when creating the tournament.
- Show a live time countdown in both the DM reminder and the canonical check-in message.
- **Time anchor confirmed:** both the DM reminder and check-in countdown target the **scheduled tournament start time**. Actual table/match start still depends on both players confirming readiness; it is not the countdown target.
- A reminder/countdown is not authorization to auto-start a match, impose a setup cutoff, or create a global deadline. Unlimited setup, both-player readiness, and the agreed match-clock/pause rules remain unchanged.

### Late check-in exception (confirmed)

- After normal attendance check-in closes, admitting a late arrival is at the admin's discretion.
- Provide a **Late check-in** button in the admin panel.
- An admitted late player enters the **next unpaired Swiss round**.
- Do not alter existing matches or already-created pairings to insert the late player.
- Do not recalculate or increase the round count locked at round one, including when **Auto** originally selected it.
- Preserve unlimited camera/SIM setup at each table.

### Technology, hosting, and admin correction scope (confirmed; not implemented)

- Use **TypeScript** with intended **personal-PC hosting** for the bot and admin website/API.
- The admin website/API is **loopback-only (localhost)**, with no LAN or public binding.
- The bot uses an **outbound Discord Gateway connection**.
- No tunnel or router port forwarding now. Remote admin access and public match browsing are deferred; preserve a portable API design.
- The existing public OpenAI-hosted website remains a disconnected mockup.
- Run **PostgreSQL locally on the personal PC**. Keep bot code, configuration, live database data, and local backup exports inside one organized project folder for portability. Do not substitute SQLite.
- Keep secrets, live data, database dumps/exports, and logs out of Git; they must not be published.
- Move database content safely with **pg_dump / pg_restore** rather than copying a running database directory. Portability still requires compatible runtime dependencies; the folder is not a standalone executable environment.
- Keep an off-PC backup copy as a desired protection; its destination and setup are not yet specified or configured. Local exports in the project folder do not protect against loss of that PC.
- **Use native Node.js and native PostgreSQL**, with project-local PostgreSQL data (PGDATA). The explicit native PostgreSQL choice replaces the earlier Docker Compose launcher plan.
- Organize the project as `apps/server` (one backend for the bot, API, and scheduler), `apps/web` (local admin), `packages/core` (shared rules), `database/migrations`, `data/postgres`, `backups`, `scripts`, and `docs`. Commit placeholder configuration only; keep real secrets private.
- Provide export/restore scripts as the normal database portability path. Install compatible native Node.js/PostgreSQL runtimes separately on the destination computer. Raw PostgreSQL files are not safe for arbitrary copying while the database is live.
- The bot must **prevent the PC from sleeping while it runs**. Proposed implementation: acquire a scoped keep-awake request while running, release it on exit, and allow the display to turn off. The request is confirmed; these implementation details remain proposed and do not authorize changing system power settings now.
- PostgreSQL schema and implementation remain unresolved. No installation or provisioning has been performed.
- Clearly retain **CAM/SIM mode** on records so admins can distinguish mode-specific abuse and remove affected scores.
- Admin action scope is **correcting and voiding results only for now**. No disqualification or suspension system.
- Preserve the original record/history, CAM/SIM mode, and admin reason. Adjust affected tournament points and recalculate/replay ELO without double-counting; do not erase evidence.
- Existing protection for downstream matches already underway remains: organizer resolution, no automatic player replacement.
- No installation, deployment, or provisioning is authorized by these documentation updates.

### Database backup, recovery, and admin page (confirmed scope)

- Include a **robust backup/recovery toolkit** and a **Database page** in the localhost admin website.
- The page shows database health, storage usage, domain-record counts, backup history, last successful backup, and restore-test status. Unavailable statistics must be labeled unavailable rather than presented as zero.
- Provide guided recovery that preserves the original database/data and requires confirmation before cutting over to a restored database.
- Keep the maintenance/recovery page available when PostgreSQL is down; store the backup/recovery metadata needed for that view outside the database.
- Restrict privileged recovery operations to the local admin path and keep them separate from the application's least-privilege database access.
- **Backup schedule:** default to a configurable **five-minute interval while a tournament is active**, plus a backup **before database upgrades**. Test overhead and prevent overlapping backup jobs.
- Show the **actual last successful snapshot/recovery point**, dump duration, and failures. A five-minute schedule is not a hard five-minute data-loss guarantee: dump time, failed jobs, or gaps can make the recovery window longer.
- **Retention (editable):** keep each five-minute active-tournament backup for **24 hours**, retain daily backups for **30 days**, and retain pre-upgrade backups. Protect the latest successfully test-restored backup from automatic cleanup.
- The 24-hour window is the lifetime of each frequent backup, not a requirement to run five-minute backups while no tournament is active. After 24 hours, a frequent backup becomes eligible for cleanup subject to protection rules.
- V1 backups are full database exports; show total backup storage use and let admins edit backup settings. Four active hours at a five-minute interval produce about 48 exports, depending on startup timing and successful jobs.
- Off-device destination, detailed safety procedures, and implementation remain unresolved. No backups, cleanup, restore tests, or recovery actions are claimed as performed.

**Safety-review recommendations (not yet approved implementation details):** keep backup manifests, recovery progress, and maintenance authentication usable independently of PostgreSQL; use separate privileged maintenance credentials; restore into a fresh database while preserving the original; serialize recovery operations; place every mutation entry point behind a maintenance lock and drain in-flight work; reconcile Discord after a rollback before resuming writes. Report connection health, checksum verification, and actual restore-test results as different checks.

### Backup copies and Documents status

- **Confirmed current status:** the user's Documents folder is not cloud-synced yet. A copy there remains local until cloud synchronization is configured and verified.
- **Confirmed two-copy workflow:** keep a project-folder backup and a verified Documents copy. This is an approved design, not a claim that copies already exist.
- Create one completed export in `TCG_Live/backups`, then make a **verified copy** in `Documents/TCG_Live Backups`. Verify copy integrity before showing success; checksum/hash details remain implementation work.
- Apply the agreed editable retention/protection rules to **both backup sets**. Keep all backup files excluded from Git.
- The Database page must show these copies as **local-only**, not cloud-backed-up, until synchronization is actually verified.
- Two copies on the same PC, especially the same physical drive, do not protect against loss of that PC or drive. An off-device backup remains unresolved.
- No cloud setup, file upload, backup creation, or copy is performed by this documentation update.

## 2. Match setup and readiness

- Use a shared bot match card in the voice/video channel's chat.
- Both players must click **Confirm Ready** before the match starts.
- Setup time is unlimited.
- There is no global deadline beginning when pairings are published.
- Match timing begins only after both players confirm readiness.
- Players handle the practical opponent, camera, and simulator checks themselves.
- The bot cannot physically prevent players from starting play in an external simulator.
- An unready table can hold up round completion. Earlier five-minute setup cutoffs and 35-minute global caps are not accepted behavior.

## 3. Match format and timing

| Setting | Agreed behavior |
| --- | --- |
| Default format | Best of one (BO1) |
| Default BO1 duration | 30 minutes |
| Alternative format | Organizer/admin can choose best of three (BO3) |
| One Piece BO3 default | 60 minutes |
| Pokémon BO3 default | 50 minutes |
| Duration configuration | Organizer/admin-editable |
| Clock scope | One clock for the entire match |
| Between BO3 games | Do not reset the clock |

### Pause and resume

- Either player may pause immediately.
- Pausing freezes the remaining match time.
- Resuming normally requires **both players** to click **Resume**.
- A judge has an override.
- There is no global deadline that continues counting down during the pause.
- Judges can grant time extensions.
- Expiry flags a judge and never determines a winner or draw.

## 4. Result reporting and confirmation

### Initial shared card

The shared card initially offers:

- **I won**
- **I lost**
- **Call judge**
- **Pause**

### After the first report

- Either player can make the first report.
- The card updates to state the proposed winner explicitly.
- It offers neutral **Confirm result** and **Dispute result** actions. The opponent should not be forced to click an emotionally difficult `I lost` label to confirm.
- Only the opponent of the reporting player may confirm or dispute that report.
- The reporter must not approve their own report.
- Opponent confirmation finalizes the result immediately.
- An admin can also finalize a result.

### Disputes, corrections, and no-shows

- A dispute does not lock the match into admin-only resolution.
- Players can mutually settle the original reported result or agree on a corrected result.
- Confirming the existing proposal closes the dispute and finalizes it. A changed result becomes a fresh proposal that the other player must confirm.
- Enforce opponent identity in the backend even when both players can see the same buttons.
- Keep **Call judge** available. Update the staff queue after resolution so stale actions cannot resolve the same match again.
- An admin can award or correct a result at any time.
- A no-show after an opponent has been assigned uses the existing **Call judge** action and an admin-awarded forfeit/result. It is not a pairing bye, does not consume pairing-bye eligibility, and does not limit additional justified forfeit wins. Unplayed no-show forfeits award configured tournament match-win points with no ELO change for either player.
- Do not add a separate elaborate no-show workflow or automatic no-show penalty.
- If a winner correction occurs after a downstream match has already started, flag the situation for organizer resolution. Do not automatically replace a player in that ongoing match.

## 5. Audit history and rating corrections

- Log every report, confirmation, dispute, correction, pause, resume, and admin action.
- Correcting a result must recalculate its ELO impact without double-counting the original and corrected result.
- Each player has **separate persistent ELO per game**, initially **1200**. One Piece and Pokémon ratings remain independent.
- **CAM and SIM initially share a game's rating**; store and visibly identify CAM/SIM on each match/result for admin review.
- Use standard logistic ELO with **fixed K=32**: EA = 1 / (1 + 10^((RB - RA) / 400)); RA' = RA + 32 × (SA - EA), where SA is win 1, draw 0.5, loss 0. Update both players from the same pre-match ratings.
- Apply one update per whole confirmed match, including BO3. Retain fractions internally and round for display.
- ELO is separate from Swiss tournament pairing and scoring.
- ELO is a persistent rating across tournaments; it does not reset for each new event.
- Played-match results, including normal concessions in played matches, update ELO against expected outcome.
- Unplayed no-show forfeits award the configured tournament match-win points with no ELO change for either player.
- **Byes and missed rounds produce no ELO change.** This does not determine the tournament-point award for a missed round.
- Initial ELO-based seeding was discussed as a possible use, not approved as the default seeding policy.

## 6. Tournament progression

- Default: automatically publish the next round when every required match result is final.
- Optional organizer setting: require an organizer click to publish the next round instead.
- Unresolved disputes and holds block progression.
- A reported-but-unconfirmed result is not final merely because a player submitted it.
- Clock expiry must not finalize a result or unblock progression by assigning an outcome.

## 7. Swiss pairing and scoring

- Swiss is the default tournament format.
- Pair players by similar tournament record/points, not ELO rating.
- Swiss matches default to BO1; an admin can select BO3.
- For BO3, use the whole-match result: a 2–0 or 2–1 series is one match win, not two match wins.
- Scoring is configurable in a Challonge-like settings model.

| Scoring field | Default |
| --- | ---: |
| Match win | 3 |
| Match draw | 1 |
| Match loss | 0 |
| Game/set win | 0 |
| Game/set tie | 0 |
| Bye | 3 |

All listed scoring fields are editable. These approved defaults supersede earlier screenshot values of 1 / 0.5 / 1. The alternative win 1 / draw 0.5 / game points 0 / bye 1 scheme was considered, not chosen; the current 3 / 1 / 0 / bye 3 defaults are approved. The presence of a configurable draw score does not authorize automatic draws when time expires.

### Event standings and points (confirmed)

- Provide an admin choice between **STANDINGS** and **PLAYOFFS** to finish a Swiss tournament. Both modes are approved.
- In **STANDINGS** mode, finish Swiss using tournament points first, then ordered tiebreakers, with the goal of establishing a winner.
- In **PLAYOFFS** mode, Swiss leads into a playoff stage. Specific cut sizes, bracket format, and qualification details remain unresolved.
- The earlier standings-based default has not been explicitly revoked. The latest dual-mode approval does not newly select a default for the finish-mode selector.
- The numerical tiebreaker sequence and formulas remain unresolved. After all selected numerical criteria are exhausted, use the confirmed exact-tie policy below; reapplying identical exhausted criteria cannot resolve an exact tie.
- Tournament points are specific to one event. Each new tournament starts at zero; points do not carry into the next event.
- Archive tournament results and member/participant lists **in the database** for future lookup and records. Preserve historical standings and audit history as well. Resetting points for a new event does not mean deleting old results or participant records.
- Keep the configured scoring defaults above: win 3, draw 1, loss 0, bye 3, with editable fields. These event points are distinct from persistent ELO.

### Exact ties after numerical tiebreakers (confirmed)

- If an exact tie remains **after all numerical tiebreakers are exhausted** and affects the **champion or final playoff qualification spot**, flag it for the organizer and arrange a deciding match/playoff **among the tied players only**.
- Keep the affected outcome unresolved until the deciding result is confirmed through the match/result workflow.
- An extra deciding match is acceptable. For exactly two tied players, one extra deciding match is the straightforward approach; more than two requires a tie-only playoff, whose exact format is still unresolved.
- If the exact tie affects only lower placements, allow a **shared rank**.
- Never silently choose a winner or qualifier by ELO, registration order, or random draw. The random choice used in pairing-bye selection does not apply to final standings.
- Clock expiry still flags a judge and never automatically awards a winner or draw.
- The numerical tiebreaker order/formulas, multiway format, deciding-match BO1/BO3 and timing, handling of a drawn deciding match, and impact on ELO/tournament points remain unresolved.

### Admin notifications for deciding ties (confirmed)

- Support **Discord and email** notifications when an unresolved exact tie affects the champion or final playoff qualification spot and needs admin attention.
- Also support the admin/judge flag when a deciding match reaches clock expiry. Expiry never automatically decides the winner or declares a draw.
- **Discord admin alerts are on by default. Email is optional and configurable per tournament.**
- This scope covers these unresolved deciding-tie and deciding-match-expiry alerts; it does not enable email for every tournament event.
- Proposed alert content: identify the tournament, tied players, and action/decision needed, with a link to the relevant Discord message.
- Actual recipients, destination Discord channel, email provider, and delivery setup remain unresolved.
- These are planned capabilities/defaults only. No notification has been sent and no integration has been implemented or configured by this documentation update.

### Pairing byes and no-shows (confirmed)

- If the active-player count is odd before pairing, assign one **pairing bye** for that round.
- Use one selection sequence for every pairing bye: **fewest previous pairing byes → lowest tournament points → random choice if still tied** among eligible players.
- Players with zero previous pairing byes naturally come first. The same sequence handles repeat byes when needed; no separate first-bye/repeat-bye settings or admin screens are required.
- Award the configured bye score (default **3 points**) and make **no ELO change**. Record the assignment.
- An opponent who fails to attend an **already-assigned match** is a no-show handled through **Call judge** and an admin-awarded forfeit/result. Do not relabel it a pairing bye.
- A forfeit win does not use up pairing-bye eligibility and does not prevent further justified forfeit wins.
- Rounds missed before a late entrant is admitted receive **0 tournament points**, are labeled **Missed round** rather than a played loss, and make **no ELO change**.
- Unplayed no-show forfeits award configured tournament match-win points with no ELO change for either player. Normal concessions in played matches remain rated.

### Round-count default (confirmed)

- Suggest the Swiss round count from **checked-in attendance**, not merely the number registered.
- The organizer may edit that count **before the event starts**.
- Once the event starts, the selected round count is **fixed**.
- **Round-count selector UI:** **Auto** is the default, calculated from checked-in attendance and locked when round one starts. A **manual count dropdown** is available before that point.
- This confirms the default selection workflow, not automatic adoption of every official event profile or research table. A specific universal cap, complete suggestion table, and variable stopping mode have not been approved.

## 8. Open decisions

These items remain unresolved and must not be silently implemented as approved policy:

- The exact Swiss attendance-to-round-count suggestion table, minimums, maximums, and any alternate event profiles; the checked-in-attendance suggestion, pre-start organizer editing, and fixed-after-start default are confirmed above.
- The exact ordered standings tiebreaker sequence and formulas.
- Tie-only playoff details: multiway format, deciding-match BO1/BO3 and duration, handling of a drawn deciding match, and ELO/tournament-point effects. The policy of an organizer-arranged deciding match/playoff for an exact champion/qualification tie is confirmed.
- Playoff cut size (for example Top 4 / Top 8 / Top 16), bracket format, qualification details, and explicit finish-mode selector default. The admin choice between PLAYOFFS and STANDINGS is approved.
- Rematch avoidance and fallback behavior when a repeat pairing cannot otherwise be avoided.
- Registration and authentication flow beyond the confirmed canonical check-in and private acknowledgment behavior.
- Admin-alert recipients, Discord destination/channel, email provider and delivery setup, and final message content. Discord-on/email-optional per-tournament defaults for deciding-tie/expiry alerts are confirmed.
- Exact live-countdown presentation, refresh precision, and implementation.
- Auto/manual next-round control UI details; the automatic default and optional organizer-click mode in section 6 are already approved.
- Initial ELO-based seeding policy; 1200 starting rating and standard logistic K=32 are now approved.
- Scoped keep-awake implementation and detailed recovery safety procedures. The backup/recovery toolkit and Database page are approved scope; no successful recovery or durability guarantee is implied.
- PostgreSQL schema and implementation details.
- An off-PC backup destination remains open. The confirmed project-plus-Documents workflow is local-only because Documents is not cloud-synced. Pre-upgrade retention duration and verification implementation details remain open; no external backup has been configured. Frequent/daily retention, pre-upgrade retention, protection of the latest test-restored backup, and editable settings are confirmed.
- Detailed implementation of correction/voiding and replay of later affected ratings. No disqualification or suspension system is included.
- CAM-versus-SIM room/channel policy, privacy, and simulator-room creation choices.
- Whether the bot operates as a Battlefy companion or as an independent tournament system.
- Detailed safe handling of corrected Swiss standings and pairings that have already been created.

### Odd-player pairing clarification

An odd number of players in a round calls for an unpaired player/bye, not an additional Swiss round. For example, 101 players produce 50 matches and one bye. Use the confirmed fewest-prior-pairing-byes, then lowest-points, then random sequence above, including when all eligible players have already had a bye. The separate no-ELO-change rule for byes is now confirmed. Late admission must preserve the already-locked round count.

## 9. Research and proposals are not decisions

- Simulator/API integration limits are research findings, not user-approved product behavior.
- Manual simulator hosting plus room-code sharing has been discussed as a practical fallback; no verified public integration has been established.
- Do not assume an automatic room-creation or game-result integration exists.
- The round-count default workflow in section 7 is approved. Specific official event profiles, research tables, and alternate stopping modes remain reference material unless separately accepted.
- Unlimited setup and the agreed pause model are custom-format choices, not a claim of compliance with sanctioned tournament rules.
- The existing prototype is a frontend-only Discord message designer with 12 editable templates, embed/button/select/modal previews, Legacy/V2 validation and JSON export, and static/GIF media support. It has no live Discord, OAuth, SIM, or media-service integration. This context does not authorize implementation of those integrations.

### Rating and database references

Starting at 1200 is a selected baseline; fixed K=32 is a launch choice, not an official TCG requirement.

- [Rating-system context](https://lichess.org/page/rating-systems)
- [Logistic Elo expected-score reference](https://probability.ca/jeff/ftpdir/chessstreaksadd.pdf)
- [FIDE rating rules](https://handbook.fide.com/chapter/B022024): unplayed-forfeit and rating-update precedent, not a TCG mandate.
- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [SQLite deployment tradeoffs](https://www.sqlite.org/whentouse.html)

### Technical reference notes (not approved integration design)

- [Discord timestamp formatting](https://docs.discord.com/developers/reference#message-formatting) supports Unix-seconds timestamps and the `R` relative-time style, rendered by the client. A live relative countdown plus an absolute start time displayed in the viewer's locale/time zone is a possible presentation, not a guaranteed second-by-second stopwatch.
- A Discord relative timestamp becomes a past-time indication after its target passes. It does not itself close check-in, start a match, impose a penalty, or trigger another action.
- Pausable match timers require authoritative remaining-time state and a revised deadline after resume; a fixed relative timestamp alone cannot enforce the agreed pause behavior.

- Discord supports updating the shared interaction message. Shared visibility does not replace backend checks that the acting user is the eligible opponent.
- A simulator room code routes players to a room; it is not proof of player identity. A Joined/Ready indication is self-reported unless a verified integration later supplies stronger evidence.
- No verified public third-party simulator API or exhaustive host-setting visibility has been established. Do not promise automatic joining, automatic settings verification, or cheat-proofing.
- Judge-only screen sharing is a recommendation, not a confirmed policy.
- One-player streaming exposes only that player's view. Do not imply one ordinary Discord judge session can simultaneously monitor two isolated rooms.

References:
- [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Discord components](https://docs.discord.com/developers/components/reference)
- [Discord messages](https://docs.discord.com/developers/resources/message)
- [Bounty League simulator rules, section 5](https://app.bountyleague.com/reglas)
- [Challonge custom point system](https://kb.challonge.com/en/article/how-to-find-and-use-challonges-custom-point-system-for-your-tournament-113qurn/)
- [Challonge ranking and tiebreak statistics](https://kb.challonge.com/en/article/rank-and-tie-break-statistics-1p5f7y4/)

## 10. Swiss round-count research (not approved policy)

Research date: 2026-10-10. There is no single universal Swiss round limit across games and event types.

### One Piece official guidance

The [official One Piece Tournament Rules Manual](https://en.onepiece-cardgame.com/pdf/tournament_rules_manual.pdf?20260116=), section 3.6, gives the following expected Swiss round counts. The official link is labeled January 16, 2026; the linked PDF cover is dated October 17, 2025.

| Players | Expected Swiss rounds |
| --- | ---: |
| 4–8 | 3 |
| 9–16 | 4 |
| 17–32 | 5 |
| 33–64 | 6 |
| 65–128 | 7 |
| 129–256 | 8 |
| 257–512 | 9 |
| 513–1,024 | 10 |
| 1,025–2,048 | 11 |

For example, 100 or 128 players corresponds to seven expected Swiss rounds; 129 or 256 corresponds to eight.

The manual distinguishes:
- **Fixed rounds:** announce the number before round one; it cannot be changed once the event begins.
- **Variable rounds:** announce the stopping criterion before play. The manual's 205-player example expects six to eight rounds and stops when one all-wins player remains.

A top cut is separate from Swiss. The manual lists Top 8 for 65–128 players, Top 16 for 129–512, and Top 32 for 513–2,048. These are source rules, not an approved top-cut policy for this bot.

### Pokémon official guidance and verification limits

The accessible [official Pokémon tournament handbook](https://mcdn.pokemon.com/pokemon-prod/raw/upload/v1/live/static-assets/content-assets/cms2/pdf/play-pokemon/rules/play-pokemon-tournament-rules-handbook-en.pdf), revision May 21, 2026, sections 5.5.4.1–5.5.4.2, distinguishes event formats. This accessible revision is not asserted to be the latest handbook: the current-site main PDF could not be retrieved during research.

For **Swiss-only / League Challenge**, the table specifies:
- 4–8 players: 3 rounds
- 9–16: 4
- 17–32: 5
- 33–64: 6
- 65–128: 7
- 129–256: 8
- 257–512: 9
- 513 or more: 10

Other event formats use different schedules:
- **League Cup:** 65–128 players: 7 Swiss + 3 elimination; 129–226: 8 + 3; 227–409: 9 + 3; 410 or more: 10 + 3.
- **Two-phase championship:** 65–128 players: 9 Swiss (7 + 2); 129–256: 10 (8 + 2); 257–512: 11 (8 + 3); 513–1,024: 12 (8 + 4); 1,025–2,048: 13 (8 + 5); 2,049–4,096: 14 (8 + 6); 4,097–8,192: 15 (9 + 6). Top cut is additional.

Pokémon counts are per age division. The separate [official September 1, 2026 Q3 update](https://www.pokemon.com/de/news/aktualisierte-play-pokemon-regeln-und-ressourcen-fuer-das-3-quartal-2026) retains a TCG asymmetrical top-cut cap of 16 (VGC/GO: 32). Neither that top-cut cap nor the Swiss-only table is a universal cap on Swiss rounds in every Pokémon event.

### Product decision following research

The user approved suggesting the Swiss round count from checked-in attendance, allowing the organizer to edit it before starting, and keeping the selected count fixed once the event starts. This supersedes the earlier undecided fixed-versus-variable proposal. Variable stopping criteria and wholesale adoption of official event profiles were not approved. The reference tables above must not silently become application defaults.

Both admin-selectable finish modes are now confirmed: STANDINGS and PLAYOFFS. Standings use tournament points first, then ordered tiebreakers. The numerical tiebreaker rules and regular playoff cut sizes/format remain pending. An exact champion/final-qualification tie after numerical criteria is settled through an organizer-arranged tie-only deciding match/playoff; lower placements may share a rank. Detailed deciding-playoff mechanics remain open.

## 11. Change history

- **2026-10-10 (cross-reviewed planning debate):** Added a separate three-reviewer debate report covering fairness counterexamples, transactional controls, rating replay, delivery, restart/restore, backups, and proposed acceptance tests. Linked it from both guides. All new recommendations remain proposals; no numerical algorithm or implementation was approved.

- **2026-10-10 (planning risk review):** Added explicitly proposed safeguards and unresolved questions for numerical standings, qualification, concurrency/consent, audit/replay, a database-backed notification outbox, backup coverage, fresh-environment recovery, and stale Discord reconciliation. No numerical tiebreak order or new implementation policy was approved by this review.

- **2026-10-10 (deciding-tie notification defaults):** Confirmed Discord and email support for unresolved champion/qualification ties and deciding-match-expiry admin/judge flags. Discord alerts default on; email is optional per tournament. Kept message content as a proposal and recipient/channel/provider setup unresolved; no sending or implementation performed.

- **2026-10-10 (exact-tie policy):** Confirmed organizer-arranged tie-only deciding matches/playoffs after numerical criteria are exhausted for champion/final-qualification ties, with the outcome unresolved until confirmed; lower placements may share rank. Extra deciding matches are acceptable. Prohibited silent ELO/registration/random selection and preserved judge-only clock expiry. Left detailed deciding-match mechanics and numerical criteria open. Reaffirmed planning-only scope and removed stale scoring-approval wording without changing approved defaults.

- **2026-10-10 (two-copy backup approval):** Confirmed a completed export in TCG_Live/backups followed by a verified copy in Documents/TCG_Live Backups, applying agreed retention/protection to both. Both remain local-only until cloud sync is verified. No backups or cloud configuration performed.

- **2026-10-10 (Documents backup discussion):** Recorded that Documents is not yet cloud-synced and the requested consideration of project-plus-Documents copies. Proposed one completed project export followed by a verified Documents copy, retaining both under the agreed policy and excluding backups from Git. Clearly labeled paths/copy mechanics as proposals and both copies local-only until cloud sync is verified; no cloud setup or data transfer performed.

- **2026-10-10 (backup retention approval and clarification):** Confirmed editable retention of each five-minute active-event backup for 24 hours, daily backups for 30 days, retained pre-upgrade backups, and protection of the latest successfully test-restored backup. Clarified active-event-only frequency versus per-copy retention and full-export storage costs with visible totals/settings. No actual cleanup authorized or performed.

- **2026-10-10 (backup schedule approval):** Confirmed configurable five-minute backups during active tournaments and before database upgrades, with overhead testing and no overlapping jobs. Require honest display of the successful snapshot recovery point, dump duration, and failures; five minutes is not a guaranteed maximum data-loss window. Added detailed recovery safety-review recommendations as proposals; retention/off-device destination remain open.

- **2026-10-10 (backup/recovery toolkit and Database page):** Confirmed a localhost Database page and robust toolkit covering health/storage/record counts, backup history and last success, restore-test status, and guided recovery preserving originals with confirmation before cutover. Keep recovery UI available during PostgreSQL outage using external metadata and separate privileged local-admin recovery from least-privilege app access. Cadence, retention, off-device destination, and detailed safety review remain open. No implementation claimed.

- **2026-10-10 (native runtime and keep-awake request):** Selected native PostgreSQL with the native Node.js application, replacing the Docker launcher plan, and retained project-local PGDATA/exports. Requested preventing PC sleep while the bot runs; scoped keep-awake/release-on-exit/display-off behavior is a proposed implementation. Corruption/recovery research remains open. No installation, power-setting change, or publishing authorized.

- **2026-10-10 (runtime decision reopened):** Reopened Docker Compose versus native Node.js/PostgreSQL after the user requested a comparison. Native runtime is recommended for consideration, not selected; existing Docker installation status is awaiting confirmation. TypeScript, localhost scope, local PostgreSQL, and the organized project folder remain confirmed.

- **2026-10-10 (Docker Compose and project layout):** Confirmed Docker Compose as the planned launcher, one apps/server backend for bot/API/scheduler, apps/web, packages/core, database/migrations, data/postgres, backups, scripts, and docs. Export/restore scripts are the normal portability route; Docker remains a separate dependency. No installation, implementation, or publishing authorized.

- **2026-10-10 (local PostgreSQL and portable project folder):** Confirmed local PostgreSQL and an organized project folder containing code/configuration, live data, and local exports. Exclude secrets/data/dumps/logs from Git. Use pg_dump/pg_restore for database migration; compatible runtime dependencies remain necessary. Container/native choice and off-PC backup destination remain unresolved; no implementation or installation performed.

- **2026-10-10 (TypeScript and localhost hosting):** Confirmed TypeScript and intended personal-PC bot/admin/API hosting, loopback-only admin/API access, outbound Discord Gateway, and no tunnel or port forwarding now. Remote admin/public browsing are deferred. PostgreSQL deployment/vendor/location remain unresolved; no installation or provisioning authorized.
- **2026-10-10 (rating, database, and correction decisions):** Confirmed per-game persistent ratings, shared CAM/SIM within each game with mode-visible records, 1200 starting rating, logistic fixed K=32, one whole-match update, fractional internal ratings, no ELO change for unplayed forfeits with configured tournament win points, rated played concessions, and PostgreSQL. Admin actions are correcting/voiding only, preserving mode, reason, history, points adjustment, and ELO replay; no disqualification/suspension system.


- **2026-10-10 (missed-round approval):** Confirmed 0 tournament points for rounds missed before late admission, labeled Missed round rather than played loss, with no ELO change. Kept the normal-win-points/no-ELO proposal for no-show forfeits pending.

- **2026-10-10 (unified bye-selection approval):** Replaced separate first-bye and unresolved repeat-bye handling with one sequence: fewest previous pairing byes, then lowest tournament points, then random choice if still tied. Log the assignment; no extra settings or screens. No-show forfeits remain separate and do not count as pairing byes. Missed-round tournament points remain pending.

- **2026-10-10 (pairing-bye selection and admin guide):** Confirmed one pairing bye for an odd active-player count, selecting players without a prior pairing bye, then lowest points, then random choice among equals. Distinguished no-show forfeits from pairing byes and retained unresolved repeat-bye fallback, missed-round points, and forfeit ELO treatment. Added a plain-language administrator rules guide.

- **2026-10-10 (finish-mode choice and database archive):** Confirmed admin-selectable PLAYOFFS or STANDINGS and database archiving of results plus member/participant lists for future records. Kept playoff details and selector-default clarification open. Refined the pending bye/missed-round proposals and recorded the alternative-scoring question without changing approved scoring defaults.

- **2026-10-10 (Swiss finish and rating clarification):** Confirmed a Swiss standings-based finish using tournament points then ordered tiebreakers, per-event points starting at zero without deleting history, persistent ELO, and no ELO change for byes or missed rounds. Left exact tiebreakers, final tied-first-place fallback, bye assignment, missed-round tournament points, rating parameters, and seeding unresolved.

- **2026-10-10 (late check-in approval):** Confirmed admin-discretion late admission through an admin-panel Late check-in button, entering the next unpaired Swiss round without modifying existing matches, created pairings, or the round count locked at round one. Recorded the odd-player/bye clarification and kept bye-assignment, ELO, and missed-round scoring proposals pending.

- **2026-10-10 (round-count selector approval):** Confirmed Auto as the default round-count selector, calculated from checked-in attendance and locked at round one, with a manual count dropdown available beforehand. The optional Top 4 / Top 8 / Top 16 playoff proposal remains pending.

- **2026-10-10 (attendance check-in closure):** Confirmed that tournament attendance check-in closes when round one starts and reaffirmed no time limit on camera/SIM setup at each table. Kept the proposed Auto/manual round-count selector UI pending.

- **2026-10-10 (reminder anchor and lead-time clarification):** Confirmed that reminders and check-in countdowns target the scheduled tournament start. Changed the default DM reminder lead from five to **10 minutes**, still configurable at tournament creation. Left attendance check-in closure at round-one publication pending. Added Discord timestamp implementation caveats without changing match-start, setup, or pause rules.

- **2026-10-10 (check-in and reminder approval):** Recorded pinned canonical channel check-in, supplementary DM links, private acknowledgments, idempotent attendance counting, a default five-minute DM lead time configurable at tournament creation, and live countdowns in DM/check-in messages. Kept the countdown's start-time anchor unresolved and preserved readiness-based match starts and unlimited setup.

- **2026-10-10 (round-count approval):** Recorded the user's approval of checked-in-attendance round suggestions, organizer editing before start, and a fixed count after start. Left the final-standings/default versus optional Top 4 / Top 8 / Top 16 playoff proposal pending.

- **2026-10-10:** Consolidated agreed TCG bot planning decisions into this repository at the user's request. Explicitly recorded that clock expiry flags a judge rather than deciding the winner or declaring a draw. Kept Swiss round count and other unsettled policies open.


## 12. Planning risk review: proposals and unanswered questions

**This entire section is a review, not approval of new behavior or an implementation report.** The numerical Swiss tiebreaker order, formulas, and related edge-case choices remain pending. Existing confirmed decisions elsewhere are unchanged.

### A. Standings and qualification

1. **Opponent-strength calculations need an exact definition.** Averaging each opponent's percentage is different from pooling all opponent points and rounds. For example, opponent percentages of 100% over one counted round and 0% over three counted rounds average to 50%; pooling those four rounds gives 25% when a win is worth 3 points. Neither calculation has been selected.
2. **Any percentage floor needs explicit placement.** Decide whether a proposed floor applies to each opponent before averaging or to the final aggregate, which results count in the numerator/denominator, and what happens for an opponent with zero counted rounds. A floor value, formula, rounding rule, and zero-round fallback are not approved.
3. **Late entry and withdrawal can distort opponent percentages.** A short high-scoring record can inflate strength if missed or unplayed rounds are handled inconsistently. Define counted rounds, late-entry missed rounds, dropped players, voided matches, and the calculation cutoff before accepting a formula.
4. **Keep result types distinct.** A pairing bye, missed round, unplayed no-show forfeit, played concession, draw, and void are not interchangeable data. Their confirmed points/ELO rules do not automatically decide how each affects opponent-strength denominators or other tiebreakers.
5. **Head-to-head must work on tied groups.** Define when the whole tied group is eligible, how incomplete meetings are treated, whether to reapply criteria to smaller groups, and how rematches or split head-to-head records behave. A two-player example does not settle multiway ties.
6. **Shared ranks do not settle playoff allocation.** Decide how three tied players competing for two remaining places are handled, how qualification and seed ordering differ, and how a shared lower rank maps to bracket seeding. The approved tie-only deciding-play policy does not select a multiway bracket or a seeding algorithm. Do not silently resolve these with ELO, registration order, or randomness.

### B. Concurrent actions and trustworthy records

7. **Consent can become stale.** Proposed safeguard: bind result confirmation/dispute and pause/resume consent to the exact match/state revision and pause generation. A click on an older proposal or a previous pause must not approve a changed result or a later resume. Define when existing consent is reset.
8. **All writers need one transactional mutation path.** Proposed safeguard: Discord actions, admin/API changes, scheduler tasks, corrections, and recovery operations use a common database-backed mutation layer. Check expected revisions and permissions, use consistent lock ordering, and keep durable idempotency/duplicate keys. In-memory duplicate detection alone does not survive restart.
9. **Shared rating pools can race.** Different matches affecting the same player's per-game rating require deterministic ordering and consistent locks. The shared CAM/SIM pool makes this relevant across modes. Define replay order and correction boundaries; avoid rating updates that overwrite each other or double-count.
10. **History must explain the current state.** Proposed safeguard: preserve original results, action authors/times/reasons, rules/scoring versions, mode, and correction/void events. Derive or reconcile standings and rating projections from that history. Snapshot the event settings used so a later settings edit cannot silently reinterpret old results.

### C. Discord delivery and database consistency

11. **A database commit and a Discord/email send are separate operations.** A crash between them can leave a saved result without its updated card or send a duplicate notice. Proposed solution: a **small database-backed notification outbox**, written in the same transaction as the state change, with retry status and duplicate-safe delivery. Do not introduce a new external queue just for this.
12. **A restored database may be older than Discord.** Proposed recovery barrier: invalidate stale controls using a restore generation/version; inspect and reconcile existing Discord cards, rounds, and pending notifications before allowing mutations again. Pause ordinary workers during reconciliation and drain in-flight operations through the common maintenance gate. This is a proposed implementation of safe recovery, not a claim it exists.

### D. Backups, restoration, and data representation

13. **“Active tournament” leaves coverage gaps.** The approved five-minute schedule needs a precise active-state definition. Registration before play, an event paused overnight, and post-event corrections may change data outside it. Backup coverage for those periods, idle-time/daily scheduling, and triggers after important changes need an explicit policy; no additional cadence is approved by this review.
14. **A normal database dump is not the whole installation.** Proposed toolkit requirement: reproducible PostgreSQL role/permission setup plus compatible application/schema/migration metadata, version information, and a recovery manifest. Keep secrets out of the repository and exports shown to others. A database dump may not include cluster roles or every runtime/configuration dependency. Test recovery into a fresh environment with the intended permissions.
15. **Health, integrity, and recoverability are different.** A successful connection does not prove absence of corruption; a checksum does not prove an export can be restored; a successful restore does not prove application-level consistency. Proposed reporting separates these checks, their timestamps, and failed/untested status.
16. **Precision and identifiers need deliberate storage.** Proposed design checks: preserve Discord snowflake IDs losslessly (avoid JavaScript Number precision loss), use explicit UTC instants and display-local time, keep rating precision separate from display rounding, and define timer/remaining-time behavior across restart. Do not let serialization silently change identity, ranking, or consent.
17. **Local copies share a failure domain.** Project and Documents copies remain local-only until cloud sync is verified. A lost PC, failed drive, or destructive account compromise may affect both. Off-device destination and actual recovery testing remain open.
18. **Localhost is a boundary, not complete authorization.** Proposed safety review: authenticate/authorize privileged admin actions, protect browser-driven requests against cross-site abuse, keep normal app database access least-privileged, and separate maintenance credentials. Backup manifests, recovery progress, and maintenance access must remain usable when PostgreSQL is unavailable. The exact auth/recovery design is not selected.

### Review exit criteria (proposed)

Before implementation, settle the numerical ranking examples and qualification edge cases, define result/state transitions and revision-specific consent, select backup coverage outside active play, and write a fresh-environment restore/reconciliation test plan. These are recommendations for the next planning decisions, not authorization to build, install, or deploy.
