# Boilerplate implementation boundary

B0 is approved for implementation. It establishes the local application shell for TCG Live; it does not implement tournament behavior or connect a Discord bot.

The existing [decision log](TCG_BOT_DECISIONS.md), [admin rules](ADMIN_TOURNAMENT_RULES.md), and [planning debate](PLANNING_DEBATE_REVIEW.md) retain their status. This milestone does not settle their open product decisions.

## Ownership and starting point

The repository began this work at e777f0046bd876cf7f277909713c9ceab7f47a34 with a README and those three documents. The implementation uses a verified checkout of Howard-Starfield/TCG_Live on codex/tcg-boilerplate.

The primary agent orchestrates and evaluates. GPT-6 Sol at medium effort implements the application and its focused tests. GPT-6 Luna handles bounded exploration and research. Claude Opus 5.5 at high effort reviewed the plan; its practical findings were incorporated after primary evaluation.

## What B0 delivers

Use native Node.js, TypeScript, npm workspaces, one lockfile, and a single apps/server application. Use Node's HTTP server and test runner, and the standard PostgreSQL driver. Compile JavaScript for the normal entrypoint and acceptance tests. Record actual runtime/dependency versions and working commands in README.

Bind HTTP explicitly to 127.0.0.1. The health routes have this contract:

| Request | Status | JSON body |
| --- | --- | --- |
| GET /livez while serving | 200 | {"status":"live"} |
| GET /readyz after a successful database probe | 200 | {"status":"ready"} |
| GET /readyz without database configuration | 503 | {"status":"not_configured"} |
| GET /readyz when the configured database is unavailable | 503 | {"status":"unavailable"} |

Unknown paths return 404. Unsupported methods on those health paths return 405 with Allow: GET. Responses and diagnostic logs must not expose connection strings, credentials, raw database/parser errors, or stack traces.

B0 has one runtime behavior: absent or whitespace-only database configuration allows the shell to start with unavailable readiness. Other malformed configuration fails with a fixed, actionable message.

Accept only postgres/postgresql URLs with an explicit user, password, port, database name, and one loopback host (localhost, 127.0.0.1, or ::1). Reject query parameters, fragments, remote hosts, and multiple hosts. Pass validated parsed fields to the driver without the original connectionString, and prevent ambient PostgreSQL settings from redirecting the intended local probe.

A short-lived client performs read-only SELECT 1. One attempt is shared by concurrent readiness requests, has a two-second total connect/query/cleanup budget, handles asynchronous errors, and releases resources on every outcome. A later request can retry after failure. Liveness remains independent. No database, schema, or migration is created automatically.

Provide idempotent shutdown that stops accepting work, finishes or cancels a pending probe, and closes resources. Enforce a five-second cleanup deadline, then force remaining HTTP connections closed. Node 24 already closes idle keep-alive connections during server.close; forced closure is a deadline fallback after that call.

## Scope limits

Reserve apps/web, packages/core, database/migrations, data/postgres, backups, and scripts in documentation until they have a concrete use. Do not populate empty abstractions or install a frontend framework for a placeholder screen.

Do not implement tournament schemas/rules, a generic workflow engine, an ORM, external queues, authentication for nonexistent admin mutations, live Discord connections, command registration, backup jobs, or power-setting changes. Real local admin mutations will require an authentication design in their own milestone.

Preserve the selected project-local data/backup layout, but do not provision it during B0. Exclude secrets, local data, exports, logs, dependencies, and generated output from Git. Keep only placeholder settings.

## Acceptance evidence

Run a clean install from the lockfile, typecheck, build, and the focused tests. Verify:

- Loopback-only binding, actionable port collisions, exact HTTP status/body/method/path behavior.
- Disconnected startup, rejected malformed/unsafe URL forms, and process-output redaction using synthetic credentials.
- Refused connections and a task-owned TCP server that never completes a PostgreSQL handshake, including a bounded failure while liveness remains responsive.
- Shared concurrent probes, cleanup after failure, and retry on a later request.
- Idempotent stop during a pending probe and an active HTTP request, bounded cleanup, and successful reuse of the port.
- Actual Windows Ctrl+C separately for the direct compiled program and the npm development launcher. Forced termination and direct stop-function tests do not substitute for console-signal evidence.
- No unintended secrets/data/build output in the proposed Git changes.

A positive PostgreSQL smoke check requires an explicitly selected disposable local target. Do not install PostgreSQL or use an unrelated application's database to fill this gap. Failure simulations cannot establish successful authentication/query execution. Report shell checks separately; B0 is not fully validated while the real database check remains unperformed.

The current results belong in [B0 validation](B0_VALIDATION.md). An unperformed check is recorded as pending.

## What follows

The next proposed milestone is a four-player private rehearsal: check-in, fixture pairings, both-ready start, pause/resume, result confirmation/dispute, admin correction, and restart. Introduce persistence, actor checks, transactions, revision-specific consent, audit history, and recoverable Discord updates only as that behavior is implemented.

Complete Swiss ranking, deciding ties, rematch policy, published-round corrections, and outage clocks still require explicit rules before competitive use. Real tournament release also requires the agreed Database page, authenticated recovery, tested backup/restore, and Discord reconciliation.

Confirmed invariants remain: unlimited setup; both-ready clock start; either player may pause; both normally consent to resume; expiry flags a judge and never awards an outcome; the reporter cannot self-confirm; started downstream matches never receive automatic participant replacement.

