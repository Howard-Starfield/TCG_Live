# Four-player local rehearsal

The user approved verifying PostgreSQL and then building a small four-player rehearsal. Keep the existing health server and native Node/PostgreSQL choice. Use a new disposable project-local database; leave unrelated databases, services, system configuration, and Discord accounts alone.

## Delivery

Provide a repeatable command-line rehearsal backed by real PostgreSQL. It exercises application rules through explicit synthetic player/admin identities. This is a local integration harness, not Discord identity verification or a usable tournament bot. A web mutation API would need authentication and is unnecessary for this step; an in-memory demo would not prove restart persistence.

Use four named fixture players, one game, one CAM mode, and one BO1 round with fixed pairs A/B and C/D. The fixture explicitly selects a match duration and win/loss points; it does not select unresolved competitive policy. No standings winner, Swiss algorithm, playoff, bye, late-arrival path, void-result semantics, real message delivery, or backup/recovery work belongs here.

## Behavior

- Registration accepts each of the four assigned players once. Publishing the fixture round requires all four and closes check-in. It does not start either match clock.
- Both assigned players must become ready before their match clock starts. Setup has no deadline. Either participant may pause. A new pause clears resume consent; both players must consent to that same pause before continuing. A judge may explicitly override with a reason.
- Persist remaining time and the time at which running began. An injected clock makes boundary tests deterministic. Expiry marks judge attention without awarding a result. Normal commands materialize elapsed time before evaluating a transition.
- Either participant may propose a winner. Only the opponent may confirm or dispute that exact proposal revision. Replacing a proposal clears old consent. Duplicate command IDs return the prior outcome; stale revisions fail without changing state. An outsider or player posing as an admin is rejected by the local actor/role mapping.
- An admin may finalize or correct a played result with a reason. Keep prior proposals, decisions, actors, timestamps, CAM/SIM mode, and reasons in audit history. Finalization/correction and the audit entry commit atomically.
- For this isolated event, derive points and per-game ratings from the current final results in stable match order, starting each fixture player at 1200 and using logistic Elo K=32. Corrections replace their contribution rather than add a second result. This does not implement a global rating replay ledger.
- Demonstrate process restart during registration: a second Node process loads the same checked-in event, then continues. Active-clock restart/outage reconciliation is not approved policy. Do not resume a persisted running clock automatically after a new process starts; reject that rehearsal continuation with a clear unsupported-state message.

## Small implementation

Keep code inside `apps/server` with a small domain module, a PostgreSQL store, and a CLI harness. Add one explicit rehearsal schema SQL file only when used. A fixture event can be stored as a versioned JSONB aggregate with append-only audit rows; this avoids a premature production tournament schema. Use a row lock and one transaction for state, command deduplication, and audit changes. Do not build a generic workflow engine, repository framework, queue, or frontend.

Schema setup is an explicit command and checks the selected database is the named disposable rehearsal target before writing. Each run creates a new fixture event; never reset or drop an existing database to rerun. Use parameterized SQL, existing loopback URL validation, bounded connection/query waits, and fixed redacted error messages. No secrets or live data enter Git.

## Acceptance

1. Finish B0 against actual PostgreSQL: readiness 200, liveness, repeated probes without lingering clients, invalid-password readiness 503, and graceful shutdown.
2. Focused domain tests cover duplicate check-in, permission failures, both-ready start, pause consent generations, time expiry, stale proposal controls, self-confirm rejection, dispute/reproposal, and result correction without double-counting.
3. The real database rehearsal proves four check-ins, process restart in registration, fixture publication, both matches' transitions, disputed-result correction, audit persistence, and correct points/ratings.
4. Race duplicate and stale commands through separate database connections. Verify one effect and consistent audit history. Inject a transaction failure and verify no partial state/audit write. Refused database writes must fail closed.
5. Repeat the rehearsal without destroying prior fixture events; run typecheck, build, and existing B0 regression tests. Stop task-owned servers afterward and record evidence and limitations.

## Plan review decisions

Claude Opus 5.5 at high effort reviewed the plan. The primary evaluation accepts these concrete clarifications:

- Use one scripted rehearsal process and an internal child entrypoint for the restart checks. Persist a generated runner ID when a clock starts. A different runner cannot mutate that running match, even if wall time would now make it expired; check ownership before elapsed-time calculation. Registration, setup, paused, expired, and final states do not accrue time across processes.
- The fixture actor map has four players and one admin; that admin also acts as judge. Never trust a caller-supplied role. Only the admin publishes the fixture round or performs judge/admin actions.
- One shared match clock uses integer epoch milliseconds, an injected clock, and remaining time clamped at zero. Reject a running-time calculation whose timestamp precedes its stored start. Pausing is legal only while running. Exactly zero expires and flags judge attention. Resume/pause are then unavailable, but result reporting and resolution remain legal. An explicit admin clock-check command persists expiry; a read-only status view never changes storage.
- Proposals require a started match and name one assigned participant as winner. No draws or before-start result reporting in this fixture. A replacement proposal always needs fresh opponent confirmation, even if it names the same winner. Confirmation finalizes and stops the clock. After finalization, only an admin correction changes the winner; require a nonempty reason and reject a same-winner correction. Admin resolution clears judge attention.
- Key applied-command deduplication by event and command ID and compare actor/payload hashes. Reuse of an applied command's ID with different content is a conflict. Check deduplication after locking the event row. Rejected commands and idempotent no-op check-ins write nothing and do not reserve a new command ID. Each applied transition increments the aggregate version and writes one matching audit sequence atomically; applied command outcomes may live in those same audit rows without another deduplication table.
- Preserve the confirmed idempotent check-in behavior. The review's suggestion to reject a repeated check-in under a new command ID is not adopted: acknowledge an already-checked-in fixture player without counting them twice or introducing another transition.
- Database schema setup requires the exact disposable database name and either an empty public schema or the expected fixture marker/schema version. Refuse an unrelated or incompatible schema. The task has now created a fresh local native PostgreSQL target and a nonsuperuser fixture database owner, under the user's latest approval. No further system installation, service registration, or existing-database replacement is needed.
- Print players in fixture order, without ranking or a champion. Keep fractional Elo internally. Add tests for command-content conflicts, different-runner running-clock rejection, exact expiry, rollback between state and audit writes, and connection refusal. Final source review confirmed that a separate read-only transaction case was redundant and required a test-only production option; remove that option and retain the actual audit-insert failure/rollback check.

The primary agent orchestrates and evaluates; GPT-6 Sol medium owns code/tests and GPT-6 Luna handles bounded exploration. No commit, push, deployment, or Discord message is part of this approval.
