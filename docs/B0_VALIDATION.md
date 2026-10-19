# B0 validation record

Recorded on 2026-10-12 for local changes on `codex/tcg-boilerplate`, based on commit `e777f0046bd876cf7f277909713c9ceab7f47a34`.

The application shell is implemented. **The B0 checks are complete, including successful authentication and `SELECT 1` against real PostgreSQL.** At the initial review, that positive check was pending. The user's subsequent approval authorized completing it and the four-player local rehearsal; a fresh disposable target was then created as described below.

## Completed checks

Environment: Windows, Node.js 24.14.0, npm 11.9.0. Tests use compiler-emitted JavaScript and Node's built-in test runner.

| Check | Result |
| --- | --- |
| `npm.cmd ci` | Clean installation from the lockfile passed. |
| `npm.cmd run typecheck` | Passed after the final code changes. |
| `npm.cmd run build` | Passed after the final code changes. |
| `npm.cmd test` | All 8 tests passed after the final code changes. |
| Clean build output | A synthetic stale file placed in `apps/server/dist/` was removed by the next build; the current entrypoint was emitted. |
| `git diff --check` | Passed. |
| Original planning documents | The decision log, admin rules, and planning debate were unchanged. |
| Git exclusions | Secrets, dependencies, compiled output, `data/postgres/`, and backups were ignored; `.env.example` remained eligible for tracking. The follow-up also excludes portable runtime files under `.local/`. |

The eight tests cover:

1. Loopback URL parsing, required explicit connection fields, and rejection of malformed or overriding URL forms.
2. Disconnected health responses, exact paths, unknown routes, and unsupported methods.
3. IPv4 loopback binding and an actionable port-collision failure.
4. Refused database connections while liveness remains available.
5. A task-owned TCP fixture that stalls the PostgreSQL handshake: bounded failure, eight concurrent checks sharing one connection, and a subsequent retry.
6. Idempotent shutdown with a pending probe and an incomplete HTTP request, the HTTP cleanup deadline, and port reuse.
7. Probe cleanup when the readiness caller has already disconnected. The fixture observes the database socket close without forcibly closing it itself.
8. Compiled-process output redaction using synthetic credentials, including a malformed URL with a nonnumeric port and an unreachable database.

Failure fixtures establish timeout, cleanup, and redaction behavior. They do not establish a working PostgreSQL login or query.

## Actual Windows Ctrl+C

Both the direct compiled entrypoint and `npm.cmd run dev` were exercised in separate task-owned interactive consoles, with database configuration empty and an available test port. Each returned the expected live/not-configured responses and listened only on `127.0.0.1`.

Sending Ctrl+C produced the application's stopped message. The original server process then disappeared, and the same port could be rebound. The npm launcher additionally displayed its normal `Terminate batch job (Y/N)?` prompt, which was answered `Y`.

The terminal's PowerShell wrapper reported exit code 1 after interruption, including in a separate signal fixture that handled SIGINT and exited normally. These checks therefore establish graceful application cleanup from the lifecycle message, process disappearance, and port reuse; they do not assert a zero wrapper exit code. No development server was left running.

These disconnected console checks preceded the final changes to build-output cleanup and graceful database-client closure. Disconnected signal handling was unchanged. A further direct-entrypoint Ctrl+C check with real database configuration passed after those changes, as recorded below. Pending-probe shutdown also has component-test coverage.

## Review and disposition

Claude Opus 5.5 at high effort inspected the implementation and reported no blockers. Primary evaluation accepted two small improvements: attempt graceful client closure before forced socket teardown, and remove stale compiler output before builds. Both were implemented and the checks above passed afterward. The reviewer also requested this validation record. No second Opus review was run after those fixes.

## Completed real PostgreSQL gate

The follow-up used native PostgreSQL 18.6 from the [Windows binary archive linked by PostgreSQL](https://www.postgresql.org/download/windows/), supplied by [EDB](https://www.enterprisedb.com/download-postgresql-binaries). Only runtime files were extracted into ignored `.local/postgresql/`; no system service or PATH change was made. The new cluster is under ignored `data/postgres/` and binds only `127.0.0.1:51948`. The fresh database is `tcg_rehearsal`, accessed by its nonsuperuser owner with a generated SCRAM password. Private task credentials remain outside Git. No preexisting database was used.

With the compiled health server on `127.0.0.1:59695`:

- Liveness returned `200 {"status":"live"}`.
- Six sequential and eight concurrent readiness requests all returned `200 {"status":"ready"}`.
- A separate observer queried `pg_stat_activity` afterward and found zero remaining `tcg_live_health` connections.
- A second server configured with a synthetic incorrect password returned `503 {"status":"unavailable"}` while liveness stayed 200. Its programmatic stop completed.
- Actual Ctrl+C on the successful server printed its stopped message. Its original PID was gone, and rebinding port 59695 succeeded. As in the disconnected checks, the console wrapper returned 1 after interruption; this is not reported as a zero-exit-code test.

The health servers were stopped afterward. The task-owned database was retained for the separately approved local rehearsal. These checks establish connectivity and resource cleanup; they do not claim active-clock outage recovery, backups, or live Discord behavior.

Tournament implementation remains outside B0. The next approved slice is defined separately in [the four-player rehearsal plan](FOUR_PLAYER_REHEARSAL_PLAN.md).
