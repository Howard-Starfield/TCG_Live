# TCG Live Discord Bot: Decision Log

Updated: 2026-10-10  
Status: Planning decisions, not an implementation-completion report.

This file records the agreed product behavior, separates unresolved questions from decisions, and keeps research from being mistaken for approval. The latest explicit user decisions take precedence over earlier suggestions.

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
- A no-show uses the existing **Call judge** action and admin-awarded result.
- Do not add a separate elaborate no-show workflow or automatic no-show penalty.
- If a winner correction occurs after a downstream match has already started, flag the situation for organizer resolution. Do not automatically replace a player in that ongoing match.

## 5. Audit history and rating corrections

- Log every report, confirmation, dispute, correction, pause, resume, and admin action.
- Correcting a result must recalculate its ELO impact without double-counting the original and corrected result.
- The ELO formula itself has not been decided.
- ELO is separate from Swiss tournament pairing and scoring.

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

All listed scoring fields are editable. These approved defaults supersede earlier screenshot values of 1 / 0.5 / 1. The presence of a configurable draw score does not authorize automatic draws when time expires.

### Round-count default (confirmed)

- Suggest the Swiss round count from **checked-in attendance**, not merely the number registered.
- The organizer may edit that count **before the event starts**.
- Once the event starts, the selected round count is **fixed**.
- This confirms the default selection workflow, not automatic adoption of every official event profile or research table. A specific universal cap, complete suggestion table, and variable stopping mode have not been approved.

## 8. Open decisions

These items remain unresolved and must not be silently implemented as approved policy:

- The exact Swiss attendance-to-round-count suggestion table, minimums, maximums, and any alternate event profiles; the checked-in-attendance suggestion, pre-start organizer editing, and fixed-after-start default are confirmed above.
- **Pending next question:** should Swiss end with final standings by default, with an optional Top 4 / Top 8 / Top 16 elimination playoff? This is a recommendation awaiting the user's decision, not approved behavior. Top-cut inclusion, size, and format remain open.
- Standings tiebreakers.
- Bye-assignment policy.
- Rematch avoidance and fallback behavior when a repeat pairing cannot otherwise be avoided.
- Registration and authentication flow beyond the confirmed canonical check-in and private acknowledgment behavior.
- Exact live-countdown presentation, refresh precision, and implementation.
- Swiss round-count selector UI: an **Auto** default calculated from checked-in attendance, locked when round one starts, plus a manual pre-start dropdown has been proposed but remains unanswered. The underlying attendance-based suggestion, pre-start organizer edit, and fixed-after-start policy are already approved; the proposed UI is not yet approved.
- Auto/manual next-round control UI details; the automatic default and optional organizer-click mode in section 6 are already approved.
- ELO formula, starting rating, and associated detailed rating policy. Earlier example values of 1000 and K=32 were not approved.
- CAM-versus-SIM room/channel policy, privacy, and simulator-room creation choices.
- Whether the bot operates as a Battlefy companion or as an independent tournament system.
- Detailed safe handling of corrected Swiss standings and pairings that have already been created.

## 9. Research and proposals are not decisions

- Simulator/API integration limits are research findings, not user-approved product behavior.
- Manual simulator hosting plus room-code sharing has been discussed as a practical fallback; no verified public integration has been established.
- Do not assume an automatic room-creation or game-result integration exists.
- The round-count default workflow in section 7 is approved. Specific official event profiles, research tables, and alternate stopping modes remain reference material unless separately accepted.
- Unlimited setup and the agreed pause model are custom-format choices, not a claim of compliance with sanctioned tournament rules.
- The existing prototype is a frontend-only Discord message designer with 12 editable templates, embed/button/select/modal previews, Legacy/V2 validation and JSON export, and static/GIF media support. It has no live Discord, OAuth, SIM, or media-service integration. This context does not authorize implementation of those integrations.

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

The next proposal remains pending: finish Swiss with final standings by default, with an optional Top 4 / Top 8 / Top 16 elimination playoff.

## 11. Change history

- **2026-10-10 (attendance check-in closure):** Confirmed that tournament attendance check-in closes when round one starts and reaffirmed no time limit on camera/SIM setup at each table. Kept the proposed Auto/manual round-count selector UI pending.

- **2026-10-10 (reminder anchor and lead-time clarification):** Confirmed that reminders and check-in countdowns target the scheduled tournament start. Changed the default DM reminder lead from five to **10 minutes**, still configurable at tournament creation. Left attendance check-in closure at round-one publication pending. Added Discord timestamp implementation caveats without changing match-start, setup, or pause rules.

- **2026-10-10 (check-in and reminder approval):** Recorded pinned canonical channel check-in, supplementary DM links, private acknowledgments, idempotent attendance counting, a default five-minute DM lead time configurable at tournament creation, and live countdowns in DM/check-in messages. Kept the countdown's start-time anchor unresolved and preserved readiness-based match starts and unlimited setup.

- **2026-10-10 (round-count approval):** Recorded the user's approval of checked-in-attendance round suggestions, organizer editing before start, and a fixed count after start. Left the final-standings/default versus optional Top 4 / Top 8 / Top 16 playoff proposal pending.

- **2026-10-10:** Consolidated agreed TCG bot planning decisions into this repository at the user's request. Explicitly recorded that clock expiry flags a judge rather than deciding the winner or declaring a draw. Kept Swiss round count and other unsettled policies open.
