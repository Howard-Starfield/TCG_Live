# Four-player rehearsal validation

Recorded on 2026-10-12 for local, uncommitted changes on `codex/tcg-boilerplate`.

The local command-line rehearsal is implemented and has passed against native PostgreSQL 18.6. It uses four synthetic player identities, one fixture admin, two fixed BO1 matches, CAM mode, and an explicitly accelerated clock. This is a database-backed integration harness; it is not a Discord tournament session.

## Results

| Check | Evidence |
| --- | --- |
| TypeScript and compilation | Typecheck passed; test and rehearsal commands built the compiled entrypoints successfully. |
| Default tests | 14 passed: 8 existing B0 tests and 6 rehearsal domain tests. The real database suite was explicitly skipped in this command. |
| Opt-in database tests | `npm.cmd run test:db` passed against the selected disposable target. Invoking it without `DATABASE_URL` failed with exit code 1 rather than reporting a successful skip. |
| Schema setup | Created the fixture schema; later setup returned `already_ready`. The database name and fixture schema marker/version are checked before normal operations. |
| Repeated rehearsal | Three runs completed with separate event IDs and 19 audit entries each, including a final run after review follow-ups. None reset earlier events. |
| Process boundary | A fresh Node child loaded and continued persisted check-in. A separate child trying to mutate a running clock was rejected without changing the event. |
| Concurrency and rollback | Duplicate-command and stale-proposal races produced one applied effect. An injected audit-insert failure and connection refusal exercised application failure behavior. No partial event/audit change remained after rollback. |
| Primary database inspection | The first two completed events retained A/B/C/D check-ins, final winners A/C, and audit sequences 1 through 19. Original admin decision, correction, reasons, actors, and CAM mode remained in audit history. The synthetic failure trigger was removed. The final event was read back through the compiled CLI and retained both final matches and the expected player totals. |

Each completed rehearsal produced these values, displayed in fixture order without assigning a rank or tournament champion:

| Player | Event points | Rating |
| --- | --- | --- |
| A | 3 | 1216 |
| B | 0 | 1184 |
| C | 3 | 1216 |
| D | 0 | 1184 |

The first match was resolved for B and then corrected to A. Recomputing the fixture from its current final results yielded one result contribution, while preserving both decisions in audit history. The final verified event is `fa21aa1d-5459-4fab-b159-8b220dc74f40`; its run preserved six prior synthetic events.

Domain regressions cover both-ready clock start, pause generations, opponent-only result decisions, confirmation of a disputed proposal, stale controls, correction protection, and exact-zero expiry that flags a judge without choosing a result. The database races use separate connections; no in-memory event cache supplies the result.

## Review

Claude Opus 5.5 at high effort reviewed the plan. Primary evaluation incorporated the process-owner guard, explicit state transitions, fixture roles, schema checks, and atomic command/audit handling. The review's suggested duplicate-check-in rejection was declined because the confirmed behavior is idempotent acknowledgment.

Primary source inspection found and fixed stale resume-generation consent, player decisions overwriting finalized/corrected results, and the missing ability to confirm an existing disputed proposal. Focused regressions cover those cases.

Final Opus source inspection reported no blockers. Primary evaluation selected and completed small follow-ups: document applied-command-only ID reservation, assert preservation of the original and corrected results in the repeatable rehearsal, and remove a redundant read-only test option from the store API. Typecheck, the 14 default tests, the separate database suite, and a final rehearsal passed afterward. No further Opus inspection was run after these focused changes. The real rollback evidence comes from an audit INSERT failure after the state UPDATE, followed by an unchanged persisted event and audit. Schema creation was exercised by the explicit `db:setup` command; the database test suite checks the already-created schema.

## Run again on this workstation

The selected native runtime is under ignored `.local/postgresql/pgsql/`, with its disposable cluster in ignored `data/postgres/`. It binds to `127.0.0.1:51948`, uses database `tcg_rehearsal`, and has a nonsuperuser application owner. The generated private credentials are in `.local/postgresql/credentials.json`. No Windows service or PATH setting was added. At completion, the task-owned database was stopped with `pg_ctl`, its process was gone, and its port could be rebound. Fixture data was retained. No development health server was left running.

From this repository root, start the retained cluster and load its credentials into the current shell without printing them:

```powershell
& .\.local\postgresql\pgsql\bin\pg_ctl.exe start -D .\data\postgres -l .\.local\postgresql\postgres.log -w -t 30
$fixture = Get-Content -Raw .\.local\postgresql\credentials.json | ConvertFrom-Json
$env:DATABASE_URL = 'postgres://' + $fixture.user + ':' + $fixture.password + '@127.0.0.1:' + $fixture.port + '/' + $fixture.database
npm.cmd run db:setup
npm.cmd run rehearse
```

The optional database regression command is `npm.cmd run test:db`. Tests create additional synthetic events, some intentionally unfinished, without deleting previous fixtures. The README documents read-only status/audit commands for inspecting an event.

When finished:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Variable fixture -ErrorAction SilentlyContinue
& .\.local\postgresql\pgsql\bin\pg_ctl.exe stop -D .\data\postgres -m fast -w -t 30
```

These runtime files and private settings exist only in this checkout and are excluded from Git. A fresh clone needs a separately prepared native disposable PostgreSQL target; the committed commands do not download or provision PostgreSQL automatically.

## Limits

No real Discord connection, player authentication, messages, UI, competitive pairing/ranking policy, draws, global rating history, or backup/restore capability is claimed. Continuation of a running clock from another process is deliberately unsupported pending an outage policy; an abandoned running fixture cannot be resumed or administratively resolved by a new runner. A new rehearsal creates a separate event. The process-boundary check proves fixture persistence, not production restart or recovery behavior. The existing HTTP service still exposes only health routes.
