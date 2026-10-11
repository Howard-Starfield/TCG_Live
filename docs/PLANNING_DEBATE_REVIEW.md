# Planning Debate Review

Date: 2026-10-10 (user local date)

**Planning only. Every recommendation and unresolved policy in this review remains a proposal unless separately confirmed in the [decision log](TCG_BOT_DECISIONS.md). This review does not approve an algorithm, authorize building, or claim implementation.**

## Review method

Three Astra reviewers at maximum reasoning effort examined database/concurrency, tournament fairness, and operations/recovery, then cross-challenged the findings. The consensus below reflects that cross-review. Resolved technical disagreements are recommendations, not user-approved policy.

## Executive conclusion

The existing native Node.js application and local PostgreSQL plan is sufficient for the intended single-PC, localhost-only scope. The review recommends strengthening transaction boundaries, history, recovery, and mathematical definitions before implementation. It does not recommend adding Redis, high availability, point-in-time recovery infrastructure, or full event sourcing for v1.

The main unresolved risk is ambiguity: rankings, exceptional results, clocks during outages, and restored Discord controls need precise rules. More infrastructure would not resolve those policy choices.

## 1. Recommended minimum data and mutation design

These are proposed safeguards, not newly approved behavior:

- Use short, common transactional mutations for Discord controls, admin/API writes, scheduled tasks, and corrections. Check actor identity, permissions, expected revision, and applicable control epoch; enforce constraints and durable duplicate protection in PostgreSQL.
- Preserve immutable accepted-result history and the reason/actor for corrections. Current standings and ratings can be derived projections without introducing full event sourcing.
- Use a small database-backed notification outbox committed with the relevant state change. Record delivery/retry state and make retries duplicate-safe where possible. Do not claim exactly-once Discord delivery: a process can fail after Discord accepts a message but before that acceptance is recorded locally.
- Preserve the evidence snapshot used for published pairings, qualification, and seeding. Corrections create new current standings, without rewriting the basis of decisions already published.
- When a correction affects a published downstream decision, propose an organizer hold and review. Existing confirmed protection remains: never automatically replace participants in a started match.
- Separate Swiss, tie-resolution, and playoff stages. A deciding match must not recursively alter the Swiss standings that caused it. Tie-stage ELO eligibility remains a user decision.
- A conservative void proposal invalidates the result and blocks dependent progress until a replacement result or explicit policy is supplied. Final no-contest semantics are not approved.

## 2. Numerical fairness: counterexamples to settle first

No numerical tiebreak order, percentage formula, floor, or eligible-result rule is approved by this review.

### Average percentages versus pooled results

Opponent A scores 100% over one counted round; opponent B scores 0% over three counted rounds:

- Average their individual percentages: (100% + 0%) / 2 = **50%**.
- Pool the results: one maximum-score result over four rounds = **25%**.

These answer different questions and need a deliberate choice.

### A percentage floor changes results depending on placement

With the same 100% and 0% opponents and a proposed one-third floor:

- Floor each opponent first, then average: (100% + 33.33…%) / 2 = **66.67%**.
- Average first, then floor the average: max(50%, 33.33…%) = **50%**.

Define zero-counted-round behavior, floor placement, eligibility, precision, and display rounding. One-third is an example under discussion, not an approved setting.

### Configurable scoring must not break normalization

If a configured match win is worth 5 points, dividing a one-win total by a hard-coded maximum of 3 produces **166.67%**. A proposed normalized match percentage needs a compatible denominator or a separate result-based definition. Do not add BO3 game bonuses into a normalized match percentage without an explicit definition.

### Late arrival and withdrawal expose competing fairness choices

A late entrant misses three rounds, then wins one:

- A played-only denominator gives **100%**.
- An event-round denominator gives **25%**.

Neither is selected. Decide which results count for the player and for opponents' strength: pairing byes, missed rounds, unplayed forfeits, played concessions, voids, and withdrawals. Confirmed tournament-point/ELO treatment does not settle tiebreak eligibility.

### Head-to-head needs a group rule

A head-to-head criterion proposed for exactly two residual tied players cannot be implemented as a pairwise sorting comparator across arbitrary groups. Define eligibility after earlier criteria, incomplete meetings, rematches, and split results. These details remain unresolved.

## 3. Qualification, seeding, and extra matches

The confirmed tie-only deciding-play policy is the starting point; its detailed mechanics remain open.

- **Three tied players for two cut spots:** choosing one winner does not allocate both places.
- **A tie entirely inside the cut:** everyone may qualify, but the tie still affects bracket seeding.
- **Three-player round robin:** A beats B, B beats C, C beats A can recreate an exact tie. The format alone does not guarantee termination.
- **Shared lower standings ranks:** these do not automatically define unique playoff seeds.
- Decide the multiway format, place allocation, seeding, deciding-match draws, duration/BO1/BO3, and stage-specific ELO/points treatment before treating an extra match as a complete algorithm.
- Judge-only clock expiry remains confirmed. Never silently substitute ELO, registration order, or a random draw for the required deciding outcome.

## 4. Pairing requires whole-round reasoning

A greedy choice can force a rematch even when a rematch-free complete pairing exists.

Assume all previous matches were draws:

- Round 1: A–B, C–D, E–F.
- Round 2: A–C, B–E, D–F.
- Greedy round 3: A–D and B–C leave E–F, repeating round 1.
- Alternative round 3: A–F, B–D, C–E avoids every rematch.

Proposed lesson: evaluate the complete round rather than irrevocably taking the first locally valid pair. How to trade crossing score groups against unavoidable rematches remains a user policy choice; no fallback ordering is selected here.

## 5. Reliable backups without overstating protection

The existing approved cadence/retention/copy rules remain unchanged. The review recommends:

- Label an export or destination copy successful only after it completes and is verified.
- Store the snapshot/recovery-point start separately from dump completion and copy completion. Actual recovery coverage can be older than the last completion timestamp.
- Prevent overlapping jobs and an accumulating catch-up backlog. A five-minute interval is not a five-minute maximum-loss guarantee.
- Project and Documents copies share the same PC failure domain until verified off-device synchronization exists.
- Four active hours create about **48 archives / 96 copies across two destinations**, before daily/protected copies and restore workspace. Display storage pressure and failures.
- Protect verified and pre-upgrade backups according to policy. Do not automatically delete protected files merely because the disk is full; report a storage decision/blocker.
- Define backup coverage during registration, paused events, and post-event correction; the meaning of “active tournament,” daily trigger, restore-test frequency, and pre-upgrade retention duration remain open.

## 6. Proposed fresh-database recovery protocol

- Restore into a fresh target while preserving the original database and evidence.
- Fail on restore errors. Avoid a `pg_restore --create` flow that targets the archived original database name when the intention is a separate recovery target.
- Keep a tiny outside-database recovery journal and active-target pointer. Track the selected backup, target, and cutover phase so recovery status survives a database outage.
- Accept allowlisted backup IDs and known job types, not arbitrary filesystem paths or shell commands from the admin page.
- Require authenticated local admin access with appropriate CSRF and Host/Origin checks. Loopback binding alone is not full authorization.
- Use separate maintenance credentials; run the Node application without elevated administrator privileges.
- Record application commit, schema/migration version, PostgreSQL server/tool versions, required extensions, and reproducible role setup. A normal `pg_dump` does not include cluster roles.
- Restore tests should validate the schema, domain records, permissions, and application compatibility, not merely whether a command exited successfully.
- If Documents later becomes synced, copy only intended completed backup artifacts. Never sync live PGDATA or secrets as part of this flow.

These are proposed implementation requirements, not performed recovery actions.

## 7. Restart versus restore: avoid unnecessary manual recovery

Proposed distinction reached in the review:

- Create a fresh control epoch on each boot so stale Discord controls cannot mutate current state.
- On a recognized normal restart, automated consistency checks and refreshed active cards can preserve durable consent and resume work. Do not require manual organizer review solely because the process restarted.
- An actual restore, interrupted cutover, or unknown lost-state window requires reconciliation and organizer review before mutation resumes.
- A rollback of the whole folder cannot reliably be detected using only metadata that was rolled back with that folder.
- Stop the old host before migration. A local control epoch does not fence a second PC running another copy.
- Clock behavior during outages, how displayed deadlines reconcile with paused/remaining time, and consent invalidation details remain open.

## 8. Long rating replays must not block urgent match controls

A long correction replay can hold locks needed by Pause. Proposed approach:

- Start with measured short replay transactions and consistent lock ordering.
- Preserve immediate Pause responsiveness; do not put all controls behind a long rating replay.
- If replay becomes too slow, consider ratings-only maintenance or an explicitly accepted maintenance window.
- Defer asynchronous projection swaps or more elaborate infrastructure until measurements demonstrate a need.

No performance guarantee or maintenance policy is approved by this review.

## 9. Additional database and delivery findings

All items below remain proposed implementation safeguards.

- Compare the exact current report revision and acting player's identity; use a distinct pause generation. Old consent cannot authorize a changed report or a new pause.
- Calculate timer changes using actual time **after acquiring the relevant lock**. PostgreSQL `now()` reflects transaction-start time; a transaction that waited on a lock must not grant extra time by treating that old timestamp as the moment an action took effect.
- Enforce one pairing batch and one assignment per player per event/stage/round, including a race between final results, late admission, and round release.
- Preserve rule versions and actual random choices in published evidence. Historical entrant records should not disappear through cascade deletion.
- Proposed ELO ordering: a stable per-game finalization ordinal. A correction retains its position; a result changing from unrated to rated needs a defined original ordinal rather than silently appending as a new match. Replay dependencies can cross tournaments and CAM/SIM: A–B, then B–C, then C–D can propagate a correction to D.
- Treat the outbox as **at-least-once/recoverable**, not exactly once. Prefer updating a canonical card to the current desired state. Obsolete queued messages must not overwrite a newer final state.
- Handle uncertain send outcomes, deleted messages, and permission errors explicitly. A retry cannot assume the original send failed simply because acknowledgment was lost.
- On normal restart, refresh active controls only and preserve durable readiness/pause consent. Actual restoration requires review; ordinary boot does not.
- Timer callbacks are scheduling aids, not authoritative clocks. Persist deadlines/remaining state and reconcile them using the chosen outage policy.

## 10. Proposed acceptance tests before implementation is called reliable

These tests are planning recommendations, not executed checks:

1. Confirm an old proposal after its winner/result changes: reject the old consent.
2. Race opponent confirmation with admin resolution: commit one accepted result without duplicate points, ELO, or progression.
3. Reuse old resume consent after another pause: require consent for the current pause generation.
4. Race clock expiry with an extension and lock contention: preserve the judge-only outcome and calculate time at the correct moment.
5. Race the final result, late admission, and round publication: create one pairing batch without duplicate or missing assignments.
6. Correct an early rated result affecting later events and both CAM/SIM modes: replay in stable order and test the A–B → B–C → C–D dependency.
7. Crash before sending, after Discord accepts a send, and before local acknowledgment: recover without claiming exactly once or overwriting current state with obsolete text.
8. Restore a backup older than Discord cards: stale controls stay invalid until reconciliation/review allows writes.
9. Fail or interrupt a dump/copy; fill the disk: partial artifacts never show success and protected backups are not silently deleted.
10. Stop PostgreSQL: maintenance status/authentication remain usable; unauthorized paths/job types are rejected.
11. Restart normally: preserve durable consent, refresh only active controls, and do not unnecessarily force full manual recovery.
12. Publish pairings, then correct their source standings: preserve publication evidence and test organizer holds, including started-match protection.

## 11. Decisions still needed

1. Numerical ranking formula/order, floor placement, zero-round behavior, and eligible matches.
2. How late entry, drops, byes, missed rounds, forfeits, and voids affect each tiebreak.
3. Multiway cut allocation, seeding, deciding-match format/draw handling, and ELO eligibility.
4. Final meaning of a void/no-contest and dependent progression.
5. Backup coverage outside active play, daily triggers, restore-test frequency, and pre-upgrade retention.
6. Outage-clock behavior and precise recovery/consent transitions.
7. Corrections affecting published but unstarted pairings, withdrawal effective rounds, and permitted result transitions before readiness or after expiry.

No code, installations, database provisioning, restore operations, or deployment were performed for this review.


## Sources informing the technical review

These references support technical constraints and proposed safeguards, not approval of tournament policies:

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Date/time functions and transaction timestamps](https://www.postgresql.org/docs/current/functions-datetime.html)
- [Database constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [Discord messages](https://docs.discord.com/developers/resources/message)
- [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
- [PostgreSQL pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)
- [Node.js timers](https://nodejs.org/api/timers.html)
- [Windows scoped keep-awake API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
