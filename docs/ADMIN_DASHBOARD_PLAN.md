# Local admin console

18–19 October 2026. Status: **approved 19 October 2026 with the default answers to decisions 1–3. Waves 0–4 complete on `feat/admin-dashboard`; not merged to `main`. `TCG_ADMIN_CONSOLE` stays off by default until a live Discord check is recorded.**

## Direction confirmed by the user (18 October 2026)

- Build a localhost-only admin console for organizers and judges. Players keep using the Discord cards; the console never performs player actions.
- The visual language is open-claude-ui, the Claude Desktop look. The layout follows Claude Desktop:
  - a sidebar;
  - a main window that is the **control console**;
  - tabs in the top breadcrumb bar that toggle a **Live preview** (match diagram) and a **List preview** (tables) beside it, in any combination.
- The Live preview recreates the n8n canvas look (square nodes, dotted connections, running ring) on React Flow and adds animated dotted edges. n8n is under the Sustainable Use License, so none of its source is copied.
- From TypeCheck, adapt the admin platform patterns: login and sessions, capability grants, HTTP hardening, audit views, plan-then-apply. Its paid AI moderation is out of scope.
- Deliver read-only monitoring first, the live canvas next, and browser-issued admin actions last.
- Implement through orchestrated parallel subagents after this plan is approved.

## Decisions

Resolved 19 October 2026 (the user approved the defaults):
- 1: installs run through `npx -y npm@11.21.1`; no global change.
- 2: original code reproducing the look; open-claude-ui is a visual reference only.
- 3: local commits on `feat/admin-dashboard` and `admin/<lane>` branches; nothing pushed; `main` untouched.

Resolved 19 October 2026 at the Wave 2 checkpoint:
- 4: yes, opt-in. A signed-in local console session counts as the configured admin only when `TCG_ADMIN_COMMANDS=1` (the demo always allows commands). Console actions are audited as `principal_kind = 'web'`, need a reason where the Discord command does, and check the same preconditions. With the flag off, Discord mode stays read-only: the session reports `commandsEnabled: false`, holds only `dashboard.read`, and the UI shows no action controls.

As originally posed, before Wave 0:
1. **npm toolchain.** Default: run installs with `npx -y npm@11.21.1`, which satisfies the repository pin without any global change. Alternatives: install npm 11 globally, or deliberately raise the pin.
2. **Design-system provenance.** open-claude-ui's own header and README say its tokens were extracted by de-obfuscating Claude Desktop's production bundles. A third party's MIT licence cannot license that material.
   - Default: apply the same rule as n8n. Reproduce the look with original token and component code, use open-claude-ui only as a visual reference, copy nothing verbatim, and drop the `anthropic-*` font names in favor of the system font stack. The components needed rewriting anyway, because many are demo-grade, so the visual result is the same.
   - Alternative: vendor its files verbatim and record your explicit acceptance in the decision log.
3. **Local commits.** Agents commit to local lane branches, and the orchestrator merges them into `feat/admin-dashboard`. Nothing is pushed, and `main` is untouched until you approve a merge.

At the checkpoint before Wave 3:
4. Whether a signed-in local console session counts as "the configured admin" for admin actions. `docs/PRIVATE_DISCORD_PLAN.md:35` currently reserves those actions for the configured Discord admin.

Later, multi-user phase:
5. Whether "roles" means console permissions, Discord role automation, or both.

## Scope

In scope:
- `packages/core`: the shared admin API contract (types, constants, a clock helper, fixtures).
- `apps/server`: inside the existing bot process —
  - authenticated admin HTTP routes;
  - a live event stream;
  - runtime adapters;
  - a demo runtime;
  - in Wave 3, admin commands.
- `apps/web`: the console (Vite, React, Tailwind, React Flow).
- Tests, demo mode, documentation.

Out of scope, for later plans:
- Tournament settings and customization screens. Each arrives with the backend feature it configures.
- Multi-round Swiss and bracket canvases.
- The Database/backup page. It must work while PostgreSQL is down (`docs/TCG_BOT_DECISIONS.md:78`), so it needs a separate maintenance process; that process can reuse `apps/web` and the admin HTTP layer.
- Discord OAuth multi-user login and role grants.
- Notifications, moderation, remote access or tunnels, and PostgreSQL provisioning.

No placeholder screens are built for any of these.

## Experience

**Shell.** A collapsible sidebar lists events: the active session first with a live indicator, retired sessions below as read-only history. Connection status and the account sit at the bottom.

**Top bar.** It holds, left to right:
- a breadcrumb `TCG Live › <event> › <stage>`;
- two toggle tabs, *Live preview* and *List preview* (`aria-pressed`, shortcuts Alt+1 and Alt+2);
- Discord and PostgreSQL status chips;
- a theme and account menu.

**Main window (controls).**
1. Stage stepper (Signup → Check-in → Round 1 → Standings) with counts. An actions row appears in Wave 3.
2. Needs-you queue: a decision card for every match with judge attention, showing the reasons (dispute, called, expired) and *Open in live preview*.
3. Activity stream: the audit log rendered chat-style, newest at the bottom, with scroll pinning and *Jump to latest*. It shows applied changes only, because rejected and no-op attempts are not stored (`apps/server/src/rehearsal/store.ts:309`).
4. Command composer (Wave 3 only, so no inert control ships earlier): slash commands mirroring `/tcg-test`, with mentions for seats and members.

**Preview dock.**
- It sits on the right and holds zero, one or two panes. With both open they stack, separated by a resizable divider.
- Open panes, sizes, the list tab and the canvas view persist in localStorage.
- Below 1100 px wide it becomes an overlay sheet.

The panes:
- **Live preview:** the Event view (Signup → Check-in → Round 1 → M1/M2 → Standings) and the Match view (per-match lifecycle). A Rounds view arrives with Swiss.
- **List preview:** Players, Matches, Audit and Discord panels tabs.

**Visual rules (the open-claude-ui look).**
- Warm surfaces in four levels, hairline borders, clay accent.
- Spring-based motion presets.
- Tabular numbers for clocks and counts.
- Single-stroke borders.
- An IME composition guard in the composer, and a scroll pin that only unpins on recent user input (250 ms intent window).
- Light and dark themes.
- `prefers-reduced-motion`: a static ring and no dash flow.

**Canvas semantics.**
- Dotted edges flow (animate) into whatever is happening now: clay for live play, slow red when waiting on a judge. Static green means done; grey means not reached.
- A rotating clay ring marks a live node; a slow red ring marks a node waiting on a judge.
- An interrupted clock, where another process owns a persisted running clock, shows as frozen with an *interrupted* label, never as a live ring.
- Clocks are display-only; the server stays authoritative.

## Architecture

The admin API runs inside the bot process, for three reasons:
- a running clock is owned by its runner (`apps/server/src/rehearsal/domain.ts:206`);
- the bot holds the session lease (`apps/server/src/discord/session.ts:86`);
- only its controller re-renders cards (`apps/server/src/discord/controller.ts:351`).

The loopback server the runtime already starts (`apps/server/src/discord/runtime.ts:318`) gains an optional admin handler. It is off unless `TCG_ADMIN_CONSOLE=1`. `/livez` and `/readyz` behave exactly as today, and `npm run dev` stays health-only.

```
browser (apps/web, static) ──HTTP + fetch-stream──▶ apps/server HTTP (127.0.0.1:PORT)
                                                      ├─ /livez /readyz        unchanged
                                                      ├─ /api/v1/*             auth, read, stream; commands in Wave 3
                                                      └─ /*                    apps/web/dist (single-page app)
                                                              │ AdminRuntime interface
                                            ┌─────────────────┴──────────────────┐
                                  DiscordAdminRuntime                   DemoAdminRuntime
                           (existing store/session reads,          (in-memory state driven by the
                            controller notifications,               real domain transition(),
                            discord.js identity cache)              scripted autoplay scenario)
```

**`AdminRuntime`** is a server-internal interface created in Wave 0:
- `status()`
- `listEvents()`
- `snapshot(eventId?)`
- `audit(eventId, afterSequence, limit)`
- `subscribe(listener)`, which returns an unsubscribe function. The runtime polls only while it has subscribers.

Wave 3 adds `applyAdminCommand()` and `refreshPanels()`.

**Change notification.**
- The controller gains `subscribe()`. It notifies after committed commands, timer applications, and card or panel changes.
- Each notification fires with `queueMicrotask` inside `try/catch` and is never awaited, so a failing subscriber cannot touch Discord replies, card refreshes or the shutdown path.
- Panel changes increment a process-local `panelRevision`, because message IDs change without bumping the event version (`apps/server/src/discord/session.ts:189-236`).
- A 5-second version check runs while streams are open, as a safety net.
- The stream manager reads one snapshot per change and sends it to every open stream, because each database read opens its own connection (`apps/server/src/rehearsal/store.ts:71-91`).

**Late binding.** The runtime HTTP server starts before Discord login and before the controller exists. So `DiscordAdminRuntime` is created first, with database reads working and status `connecting`, and the client, controller and room reconciler attach as they become ready. A dependency-injected factory makes this wiring unit-testable, because `runPrivateDiscord` has no end-to-end test.

**Demo runtime.** `npm run admin:demo` serves the console with a scripted in-memory event that uses the real domain rules. It needs no Discord and no PostgreSQL, and it is the development target and the E2E fixture.
- Autoplay mode advances on its own.
- Interactive mode (Wave 3) pauses wherever an admin decision is required.

**Data conventions.**
- Discord IDs are strings end to end, and PostgreSQL `bigint` millisecond columns are cast to numbers, as `apps/server/src/rehearsal/store.ts:179` does.
- Times are UTC epoch milliseconds.
- Live clocks come from the shared `remainingMsAt()` helper in `packages/core`, plus a server-time offset carried by the stream.

## Security

Loopback binding alone is not authorization (`docs/PLANNING_DEBATE_REVIEW.md:110`).

**Request checks.**
- Accept only `Host` values naming the bound port on `127.0.0.1` or `localhost`. This defends against DNS rebinding.
- Require an allowlisted `Origin` on every non-GET request: the served origin, plus `TCG_ADMIN_DEV_ORIGIN` in demo mode only.
- Never send CORS headers.

**Login.**
1. At startup the process prints `http://127.0.0.1:PORT/#login=<token>`. The launch token is 32 random bytes, valid for the life of the process, and printed nowhere else.
2. The SPA posts the fragment to `POST /api/v1/session` and strips it from history. The server compares the token in constant time, behind a modest global rate limit.
3. The server returns a random bearer session token. The SPA keeps it in `sessionStorage` and sends `Authorization: Bearer` on every request.

Session handling:
- Only a hash of each session token is stored.
- Sessions expire after 2 hours idle or 12 hours in total. An open stream counts as activity, so a monitoring screen stays signed in up to the absolute limit.
- Logout and expiry close that session's streams.
- An authenticated *Rotate link* action prints a fresh console link without a restart, which matters because a restart interrupts running clocks.

**Why not a cookie.**
- Cookies are scoped by host, not port, and `127.0.0.1:8080` counts as the same site as `127.0.0.1:3000`. So a session cookie would be sent to any other local server the browser visits, and a demo console and the live console would also overwrite each other's cookie.
- `sessionStorage` is isolated per origin, port included, and a bearer header is never attached automatically. TypeCheck makes the same choice (`.temp/TypeCheck/server/http.ts:152`).
- Consequences: `EventSource` cannot send headers, so the stream is read with `fetch` and a small parser, and each new tab signs in through the console link.

**Response headers and errors.**
- CSP: `default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- Also `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- API responses send `Cache-Control: no-store`. `index.html` is served with no-cache, and hashed assets are cached as immutable.
- Bodies must be JSON, with size and depth limits, and unknown keys are rejected.
- Rule errors are shown to the admin; all other errors are generic. Tokens are never logged.
- In Discord mode the process refuses to start if `TCG_ADMIN_LOGIN_TOKEN` is set.

**Authorization.** Every route checks a capability: `dashboard.read`, `event.publish`, `signup.manage`, `match.judge`, `match.correct`, `panels.refresh`. The local admin holds all of them. A later Discord-login principal with role grants (the TypeCheck pattern) can replace it without route changes.

**Commands (Wave 3).**
- Only admin domain commands are accepted: publish, signup close/reopen/remove, judge-resume, resolve and correct, plus panel refresh.
- Each carries a client UUID (`command_id = web:<uuid>`) and a precondition describing the state the admin saw.
- Order of checks: a prior result for the same `command_id` is returned first, so a retried success never gets a 409. Then the precondition is checked under the event's `FOR UPDATE` lock, and a mismatch returns 409 with the latest snapshot.
- Audit rows record `principal_kind = 'web'`.
- In Discord mode, commands also require `TCG_ADMIN_COMMANDS=1`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TCG_ADMIN_CONSOLE` | `0` | Serve the console from the Discord runtime. It stays off by default until a live check is recorded; the demo is always on. |
| `TCG_ADMIN_COMMANDS` | `0` | Wave 3: allow browser-issued admin commands in Discord mode. The demo always allows them. |
| `TCG_ADMIN_DEV_ORIGIN` | unset | Demo only: an extra allowed Origin for the Vite dev server, for example `http://localhost:5173`. |
| `TCG_ADMIN_LOGIN_TOKEN` | unset | Demo only: a fixed launch token for E2E tests. Discord mode refuses to start when it is set. |
| `TCG_ADMIN_WEB_DIST` | resolved from the module location | Location of the built web assets. Workspace scripts run in `apps/server`, so the default must not depend on the working directory. |

All parsing lives in `apps/server/src/admin/config.ts`, created in Wave 0.

## API contract v1

The source of truth is `packages/core/src/admin-contract.ts`, created in Wave 0 from Appendix A. Changes in the middle of a wave go through the procedure under Execution plan.

| Method | Path | Capability | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/session` | session | `SessionDto`, or 401 |
| POST | `/api/v1/session` | none | `{ token }` (the launch token) in; returns `SessionGrantDto` |
| DELETE | `/api/v1/session` | session | 204; closes that session's streams |
| POST | `/api/v1/session/rotate-link` | session | 204; prints a fresh console link, and the old launch token stops working |
| GET | `/api/v1/status` | `dashboard.read` | `RuntimeStatusDto` |
| GET | `/api/v1/events` | `dashboard.read` | `EventSummaryDto[]`, newest first; only events that have a session |
| GET | `/api/v1/events/:eventId/snapshot` | `dashboard.read` | `EventSnapshotDto`; retired events are read without `getSessionState` |
| GET | `/api/v1/events/:eventId/audit?after=&limit=` | `dashboard.read` | `AuditEntryDto[]`, ascending; `limit` at most 500 |
| GET | `/api/v1/stream` | `dashboard.read` | Server-sent event stream for the active event, read with `fetch` |
| POST | `/api/v1/commands` | per command | Wave 3: `AdminCommandResultDto`, or 409 with a snapshot |
| POST | `/api/v1/panels/refresh` | `panels.refresh` | Wave 3: `PanelRefreshResultDto` |

**Stream behavior.**
- Each connection begins with `hello`, which carries `apiVersion`, `buildId` and `bootId`. A tab whose build differs reloads itself.
- Next comes a `change` with the full snapshot and the audit entries after `Last-Event-ID`. Later changes are coalesced within 50 ms, and `status` is sent when runtime status changes.
- Heartbeats: a comment ping every 15 s and a `heartbeat` event with server time every 30 s.
- Event IDs are `<bootId>.<eventId>.<version>.<panelRevision>`. When the ID shows a different boot or event, the server sends a full snapshot plus the last 200 audit entries.
- Responses carry `Connection: close`, and at most 20 streams may be open at once.

**Shutdown order.**
- `admin.close()` is the first step of the runtime's `shutdown()`. It ends streams, answers new requests with 503, clears timers and unsubscribes.
- This keeps the 5-second watchdog (`apps/server/src/discord/runtime.ts:290`) out of reach, and `server.stop()` also calls it, idempotently.

## Execution plan

**Orchestration.**
- The orchestrating session runs Wave 0 itself, then launches lane agents in parallel.
- Each lane works in its own git worktree under `C:\Users\sdokd\Downloads\TCG_Live-lanes\<lane>`, on branch `admin/<lane>`, created from the integration branch `feat/admin-dashboard`.
- The orchestrator creates the worktrees and installs dependencies in them one after another, from a warm npm cache, because concurrent installs on Windows can fail with EPERM. Only then does it launch the agents, giving each its absolute worktree path.
- After each wave the orchestrator merges the lane branches, runs every gate, and has a fresh read-only review agent examine the merged diff before the next wave starts.
- Lanes may use read-only helper agents but never spawn agents that write.

**Dependency graph.** Lanes on the same vertical run in parallel. Each `merge` is an orchestrator integration step with all gates and a fresh review.

```
Wave 0 ─┬─ L1 server-http ────┐
        ├─ L2 server-runtime ─┤
        ├─ L3 web-kit ────────┼─ merge ─┬─ L6 web-shell ─┐
        ├─ L4 web-data ───────┤         └─ L7 web-lists ─┴─ merge ─ L8 qa ─ user checkpoint
        └─ L5 web-flow ───────┘                                                 │
          ┌─────────────────────────────────────────────────────────────────────┘
          ├─ L9 server-commands ─┐
          └─ L10 web-commands ───┴─ merge ─ L11 qa ─ Wave 4 close-out
```

**Parallel-safety rules.**
1. Contract first. Every cross-lane interface exists after Wave 0: the contract and clock helper, `AdminRuntime`, the admin config module, the full mount interface, the web dev-gallery registry, per-lane CSS entry files, and boundary stubs.
2. Each lane has exclusive file ownership (see the lanes below). Touching another lane's files needs orchestrator approval.
3. Dependency freeze. Wave 0 installs every dependency, and lanes never edit `package.json` or `package-lock.json`. A missing dependency is reported, not added.
4. Existing tests stay green in every lane. Existing test expectations may change only in Wave 3, with written justification.
5. Contract changes mid-wave:
   1. The lane stops and reports the change it needs.
   2. The orchestrator commits the change to the integration branch.
   3. The orchestrator tells every affected lane to merge the integration branch before continuing.
6. Reference repositories are untracked, so worktrees do not contain them. Lanes read them through absolute paths under `C:\Users\sdokd\Downloads\TCG_Live\.temp\`, read-only, and never run code from them.
7. Only the QA lanes (L8, L11) run E2E tests. Each run uses its own port and `reuseExistingServer: false`, serves a prebuilt `dist`, and never rebuilds inside the test-server step.
8. Each lane finishes with typecheck, tests and build green, a commit carrying the attribution trailer, and a report: files changed, each acceptance criterion and its evidence, deviations, risks.

**Toolchain.**
- npm 12.0.1 is installed, but the repository pins npm `>=11.9.0 <12` with `engine-strict`.
- The default command is `npx -y npm@11.21.1 ci --prefer-offline --no-audit --no-fund`, retried up to three times on EPERM or EBUSY. npm 11.21.1 was verified to pass the engine check.
- Peer and engine ranges were checked on 18 October 2026: Vitest 5, @vitejs/plugin-react 6 and @tailwindcss/vite 4.3 all accept Vite 8, and jsdom 30 needs Node `^24.15.0`, which Node 24.18.0 satisfies.

### Wave 0: foundations (orchestrator, sequential)

**Repository and packages**
- Branch `feat/admin-dashboard` from `main`. Add `.temp/`, Playwright output and `apps/web/dist/` to `.gitignore`.
- Workspaces: `packages/core`, `apps/server` and `apps/web`.
- Root `build` stays server-only, so `dev`, `discord:prepare` and the other bot scripts never need Vite or Tailwind. Add `build:web`, `build:all`, `typecheck:web`, `test:web`, `test:all`, `admin:demo`, `web:dev` and `test:e2e`.
- `packages/core`:
  - it emits JavaScript plus type declarations, and is a composite TypeScript project;
  - the server references it, and server `build` and `typecheck` use `tsc -b`, so every bot script builds core first;
  - Vite aliases `@tcg-live/core` to its source.
  - Contents: the contract, the `remainingMsAt()` clock helper, and hand-written fixtures (signup open, check-in, live plus dispute, final, and an audit timeline). L2 validates the fixtures against real mapper output.

**Server seams**
- `admin/config.ts`.
- `admin/runtime-types.ts`.
- The `admin/mount.ts` stub. Its full interface:
  - `createAdminHandler(options)` returns `{ handle(request, response): boolean; loginUrl(): string | null; rotateLoginUrl(): string; close(): Promise<void> }`;
  - `options` holds the runtime, port, mode and `commandsEnabled`, plus optional `webDist`, `devOrigin` and `fixedLoginToken`;
  - the stub's `handle` returns `false`.
- `startServer(config, { admin? })`:
  - consults `admin.handle` for every path except `/livez` and `/readyz`, and keeps today's 404 when the handler declines;
  - `/livez/` and `/readyz?x=1` stay 404 JSON, as `apps/server/src/test/server.test.ts:66-69` requires;
  - its `stop()` calls `admin.close()`.
- Test globs:
  - `test` gains exactly `dist/admin/**/*.test.js`; a looser pattern would run `demo.js` as a test and hang;
  - `test:db` gains `dist/admin/**/*.db.test.js`.

**Web scaffold**
- `apps/web`, with every dependency pinned exactly:
  - runtime: React and React DOM 19.3.1, motion 14.3.0, @xyflow/react 12.12.0, lucide-react 1.59.0, @tanstack/react-query 5.104.4;
  - build: Vite 8.3.4, @vitejs/plugin-react 6.1.2, Tailwind CSS and @tailwindcss/vite 4.3.3, TypeScript 6.0.2 (matching the server);
  - types: @types/react and @types/react-dom 19.3.0, @types/node 24.10.0 (matching the server);
  - test: Vitest 5.0.5, @testing-library/react 16.3.3 with its required peer @testing-library/dom 10.4.2, @testing-library/user-event 14.6.8, @testing-library/jest-dom 7.0.1, jsdom 30.1.3, @playwright/test 1.64.1 (using the installed Chrome, no browser download).
- Vite configuration:
  - the proxy sends `/api` to `TCG_ADMIN_API`, default `http://127.0.0.1:3000`, with `changeOrigin`;
  - dev galleries are excluded from production builds.
- Vitest setup provides ResizeObserver, DOMMatrix and matchMedia shims, and excludes `e2e/`.
- Playwright uses `channel: 'chrome'`, a per-run port and `reuseExistingServer: false`.
- `src/styles/tokens.css`: original token definitions reproducing the look. They cover surfaces, text, hairlines, clay accent, success and danger colors, radii, shadows, easing curves and the system font stack.
- `src/styles/app.css`:
  - imports Tailwind;
  - declares `@custom-variant dark (&:where(.dark, .dark *))`;
  - imports pre-created empty per-lane CSS files: `ui/ui.css` (L3), `features/flow/flow.css` (L5), `features/shell/shell.css` (L6), `features/lists/lists.css` (L7).
- The dev gallery registry (`#/__kit`, `#/__flow`) with placeholder pages owned by L3 and L5.

**Gate**
- Pin `npm@11.21.1` and warm the cache with one install.
- `npm ls vite` must show a single version.
- A smoke test imports every library, plus one jsdom render test and one Playwright test on the installed Chrome.
- From a fresh worktree:
  - install;
  - typecheck, tests and build are green;
  - existing server tests pass unchanged, including the import check at `apps/server/src/discord/runtime.test.ts:34`;
  - `discord:run`'s build path works without the web workspace.
- Commit. Then create the lane worktrees and install in them one after another.

### Wave 1: parallel build (five lanes)

**L1 server-http.** Owns `apps/server/src/admin/http/**` and `apps/server/src/admin/mount.ts`.

Build:
- router;
- request checks: Host; Origin (dev origin in demo only); every response header listed under Security; body limits; strict JSON;
- login and sessions: the launch token for the process lifetime with constant-time comparison and a global rate limit; hashed bearer sessions; idle and absolute expiry, counting open streams as activity; logout; rotate-link;
- capability guard;
- read routes against `AdminRuntime`;
- the stream manager:
  - subscribes to the runtime only while streams are open;
  - reads one snapshot per change and fans it out;
  - coalesces within 50 ms, sends heartbeats, and resumes from `Last-Event-ID` (boot, event, version, panel revision);
  - caps streams at 20, closes them on logout and expiry, and sends `Connection: close`;
- `close()`: ends streams, answers 503 afterwards, clears timers, unsubscribes; idempotent;
- static serving of `apps/web/dist`: SPA fallback that never captures `/livez` or `/readyz` variants; MIME map; traversal protection; no-cache `index.html`; immutable hashed assets.

Tests, using a stub runtime:
- Host and Origin rejection; dev origin rejected outside demo;
- bearer handling: missing, unknown, expired and logged-out tokens, with no token in logs or URLs;
- 401, 403, 404 and 405 responses, with health routes unchanged;
- rate limiting;
- stream resume across a version change and across a reboot;
- `close()` ending open streams quickly, plus a full shutdown sequence with an open stream inside the budget;
- traversal attempts;
- CSP and other header presence.

**L2 server-runtime.** Owns `apps/server/src/admin/runtime/**` and `apps/server/src/admin/demo.ts`. Its only other edits:
- `discord/controller.ts`: `subscribe()`, microtask notifications, `panelRevision` increments, and a read-only `status()` getter exposing `updatePending`, which comes from the private `dirty` and `refreshed` fields.
- `discord/runtime.ts`: honor `TCG_ADMIN_CONSOLE`, create the runtime before `startServer`, attach the client, controller and room reconciler later, make `admin.close()` the first step of `shutdown()`, and print the login link.

Mappers:
- event state, session and identities → snapshot, including the `members` directory and `panelRevision`;
- audit rows → entries:
  - `commandId` included;
  - the actor is the timer when `principal_kind = 'system'`, even though `actor_id` says admin (`apps/server/src/rehearsal/store.ts:276,313-316`);
  - `via` is `cli` when the principal kind is null;
  - `bigint` columns are cast;
- judge details from the audit since judge attention was last cleared (confirm, resolve or correct). `judge` is null exactly when attention is false; this correctly handles a dispute followed by a new proposal (`apps/server/src/rehearsal/cli.ts:47-48`);
- `clock.state`: interrupted when a running clock belongs to another runner, and frozen for retired events;
- `adminActions` per match and per event, computed from the domain rules. For example, judge attention during setup offers no resolve (`apps/server/src/rehearsal/domain.ts:295`);
- `stage`;
- standings through `deriveFixture`.

`DiscordAdminRuntime`:
- reads through the existing store and session functions;
- read-only queries for session-backed events, retired events (without `getSessionState`) and paged audit;
- a discord.js identity cache with a 5-minute TTL. It fetches single members by ID over REST: no bulk member requests and no new gateway intents;
- status from the gateway, lease, controller getter and room reconciler;
- late binding through a dependency-injected factory;
- version polling only while subscribed.

`DemoAdminRuntime`: the real `transition()`, a deterministic scripted scenario with fake names, an autoplay loop, short real-time clocks, and demo-only fixed-token and dev-origin support. Plus the `admin:demo` CLI.

Tests:
- mapper cases for every phase, proposal and judge state, including the dispute-then-new-proposal sequence and an interrupted clock;
- a subscriber that throws leaves Discord replies and card refreshes unchanged;
- late-binding wiring with fakes;
- demo determinism with an injected clock;
- fixtures checked against mapper output;
- existing controller tests untouched.

**L3 web-kit.** Owns `apps/web/src/ui/**` and `apps/web/src/dev/KitGallery.tsx`.

The provenance rule (if the default is accepted): reproduce the look with original code. Study `.temp/open-claude-ui` as a visual reference only; copy none of its CSS or TSX; do not use the `anthropic-*` font names. Build on the Wave 0 tokens and never rename them; component variables go in `ui/ui.css`.

Components:
- Button, SegmentedControl, status indicators;
- Dialog and ConfirmDialog (with an optional required reason);
- ScrollFade, CodeBlock, Disclosure, DecisionCard;
- SplitPane: horizontal and vertical, 4 px deadzone, double-click snap, collapse threshold;
- CommandComposer: slash and mention triggers, IME guard;
- SidebarList, ToggleTab and TabStrip, Breadcrumb, Badge/Chip, Tooltip, Toast;
- DataTable: sorting, sticky header, empty state, tabular numbers;
- Field, Input, Textarea, Select, Switch;
- Avatar (Discord avatar with an initials fallback), EmptyState, Kbd, PaneHeader, Menu/Popover, ThemeProvider;
- motion presets and hooks: scroll pinning, roving focus, backoff.

The gallery shows every state in light and dark.

Tests: keyboard and ARIA behavior, the IME guard, and focus handling in dialogs and toasts.

**L4 web-data.** Owns `apps/web/src/data/**`.

Build:
- typed client and error mapping, using the bearer token from `sessionStorage`;
- session bootstrap: fragment login, history strip, 401 handling, rotate-link call;
- stream client over `fetch`:
  - a small parser, sending `Last-Event-ID` on reconnect;
  - a 45 s watchdog and jittered backoff;
  - offline state;
  - reload when `hello` shows a different build;
  - full refetch when the boot changes;
- TanStack Query keys and stream-driven cache updates;
- `useServerNow()` from the stream's time offset, and `useMatchCountdown()` on top of `remainingMsAt()`;
- audit entry formatting;
- preferences store (`useSyncExternalStore` over versioned localStorage): panes, sizes, split ratio, sidebar, theme, list tab, canvas view.

Tests use fake fetch streams and fake timers.

**L5 web-flow.** Owns `apps/web/src/features/flow/**` and `apps/web/src/dev/FlowGallery.tsx`.

Build a React Flow canvas with:
- stage, match and state-chip nodes;
- one custom edge: bezier, dotted, with states done, active, waiting, blocked, pending and muted; a flowing dash animation; a traveling dot on active edges; arrowheads; labels;
- live and waiting rings, and the frozen *interrupted* state, with reduced motion honored;
- deterministic layouts for the Event and Match views, mapped purely from the snapshot;
- clocks from `remainingMsAt()` with an injected `getServerNow` (default `Date.now`; L6 wires L4's offset), ticking without re-layout;
- at most five graph updates per second;
- read-only interaction: clicking a match opens the Match view; fit and zoom; keyboard focus; descriptive labels.

Tests: mapping for every fixture and phase, plus a render smoke test.

### Wave 2: integrate, shell and lists

The orchestrator merges Wave 1, resolves conflicts, runs the gates and the review agent, and adds the `ListPreview` boundary stub.

**L6 web-shell.** Owns `apps/web/src/app/**`, `src/features/shell/**`, `src/features/console/**` and `src/App.tsx`.
- Sidebar.
- Top bar with breadcrumb, toggle tabs and the rotate-link item in the account menu.
- Preview dock: split, persistence, shortcuts, responsive sheet below 1100 px, spring transitions.
- Main controls: stepper, needs-you cards with reasons, activity stream. No composer yet.
- Login screen.
- Connection, lease, database and interrupted-clock banners.
- The Live preview pane hosting L5, with L4's server clock wired in.

**L7 web-lists.** Owns `apps/web/src/features/lists/**`.
- Players, Matches, Audit and Discord panels tabs on the kit DataTable.
- Names come from the `members` directory.
- Audit gets filters, paging and a raw JSON disclosure.

**L8 qa.** Runs after L6 and L7 merge. Owns `apps/web/e2e/**` and a draft of `docs/ADMIN_DASHBOARD_VALIDATION.md`.
- Playwright against `admin:demo` with a fixed demo token and its own port.
- Covers login, rotate-link, toggles and their persistence, live updates, canvas states, list tabs, keyboard paths, reduced motion, and a pass below 1100 px.
- Light and dark screenshots at 1280 and 1440 px.

**Gate.** The read-only console works end to end on the demo, and review findings are resolved.
- Manual check: Windows Ctrl+C with an open stream stops cleanly (`docs/BOILERPLATE_PLAN.md:53`).
- **Checkpoint with the user:** a demo walkthrough, plus decision 4, before Wave 3.

### Wave 3: admin actions

**L9 server-commands.** Owns:
- `apps/server/src/admin/commands.ts`;
- `apps/server/src/admin/http/routes-commands.ts`, with its registration in the router;
- the command additions to `runtime-types.ts`.

Agreed edits elsewhere:
- `rehearsal/store.ts`: one transaction body parameterized by principal kind. `applyDiscordCommand` becomes a thin wrapper, so the Discord and web paths cannot drift.
- `discord/controller.ts`: `applyAdmin()` and `refreshExplicit()`, which the slash commands reuse. Web commands therefore get the controller's tracking, accepting and lease gates, `schedule(latest.state)` (so a judge-resume arms its expiry timer), the match-room sync, and the "saved; display pending" reply.
- The demo runtime: command support.

Tests:
- validation and capabilities;
- a prior `command_id` returned before preconditions are checked;
- preconditions checked after the lock;
- a reused UUID with different content is a conflict;
- rule errors;
- card-refresh and room warnings propagate;
- slash-command behavior unchanged;
- an opt-in database test, skipped without `DATABASE_URL`.

**L10 web-commands.** Owns `apps/web/src/features/commands/**`, plus agreed action slots in console and list components.
- Stepper actions row, decision-card actions, Players remove, Matches resolve/correct/judge-resume, panel refresh.
- Reason dialogs, with danger styling for corrections.
- The command composer: parsing, suggestions, mentions, execution.
- Pending states, toasts, and 409 handling that shows the fresh state before a retry.

**L11 qa.**
- E2E for every command on the interactive demo.
- Regression run of every suite.
- Update to the validation document.

**Gate.** Everything green, review resolved, and both admin flags still off by default.

### Wave 4: close-out (orchestrator)

- README section and `.env.example` additions.
- The validation record, separating offline proof from pending live checks.
- A decision-log entry and a final review.
- `TCG_ADMIN_CONSOLE` stays off by default until a live Discord check with the console enabled is recorded.
- The user decides on merging to `main`.

## Validation boundary

Offline proof:
- unit tests (server `node:test`, web Vitest);
- E2E on the demo runtime;
- screenshots;
- the shutdown tests.

Not covered offline:
- A live Discord session with the console enabled, which needs the user's token and players.
- PostgreSQL-backed tests: this checkout has no local PostgreSQL, so `test:db` runs only when the user provides `DATABASE_URL`.

Provisioning PostgreSQL is not part of this plan.

## Risks

| Risk | Mitigation |
| --- | --- |
| Admin code destabilizing the live bot | Off by default. Notifications are microtask-isolated and never awaited, admin promises always handle rejection, and commands are separately opt-in. |
| Open streams blocking the 5-second shutdown watchdog | `admin.close()` runs first, streams use `Connection: close`, and timers are cleared; covered by a test and the manual Ctrl+C check. |
| Parallel merge conflicts | Contract-first seams, exclusive ownership, dependency freeze, merges per wave, the contract-change procedure. |
| Concurrent npm installs failing on Windows | A warm cache, worktrees installed one after another by the orchestrator, retries. |
| Localhost abuse (CSRF, DNS rebinding, cookie sharing across ports) | Host and Origin checks, bearer tokens in per-origin `sessionStorage`, JSON-only bodies, no CORS, a strict CSP, tests. |
| Design-system provenance | Default: original code reproducing the look (decision 2). |
| Web commands drifting from the Discord path | One transaction body, one controller path, existing tests as the guard. |
| Clock drift or false live states | Server-derived clock state, display-only countdowns, interrupted clocks shown as frozen. |
| Cost of many agents | At most five concurrent lanes, a review per wave, and a user checkpoint before Wave 3. |

## Appendix A: contract draft (`packages/core/src/admin-contract.ts`)

```ts
export const ADMIN_API_VERSION = 1 as const;

export type Snowflake = string;               // Discord IDs never become numbers
export type Seat = 'A' | 'B' | 'C' | 'D';
export type MatchId = 'M1' | 'M2';
export type CardSlot = 'checkin' | MatchId;
export type MatchPhase = 'setup' | 'running' | 'paused' | 'expired' | 'final';

export const CAPABILITIES = ['dashboard.read', 'event.publish', 'signup.manage',
  'match.judge', 'match.correct', 'panels.refresh'] as const;
export type Capability = typeof CAPABILITIES[number];

export interface PrincipalDto { kind: 'local'; id: 'local-admin'; label: string }
export interface SessionDto {
  principal: PrincipalDto; capabilities: Capability[];
  expiresAtMs: number; idleExpiresAtMs: number;
  mode: 'discord' | 'demo'; commandsEnabled: boolean;
}
export interface SessionGrantDto { token: string; session: SessionDto }   // bearer token; kept in sessionStorage

export interface RuntimeStatusDto {
  mode: 'discord' | 'demo'; bootId: string; buildId: string;
  serverTimeMs: number; startedAtMs: number;
  gateway: 'ready' | 'connecting' | 'reconnecting' | 'offline' | 'not_applicable';
  database: 'ready' | 'unavailable' | 'not_configured';
  lease: 'held' | 'lost' | 'not_applicable';
  cards: { updatePending: boolean };
  rooms: { enabled: boolean; warning: string | null };
  commandsEnabled: boolean;
}

export interface EventSummaryDto {            // session-backed events only; CLI rehearsal events are not listed
  eventId: string; status: 'active' | 'retired'; kind: 'legacy' | 'signup';
  createdAtMs: number; retiredAtMs: number | null; version: number;
}

export interface MemberDto { id: Snowflake; displayName: string | null; avatarUrl: string | null }

export type JudgeReason = 'dispute' | 'called' | 'expired';
export type MatchAdminAction = 'resolve' | 'correct' | 'judgeResume';
export type EventAdminAction = 'publish' | 'signupClose' | 'signupReopen' | 'signupRemove';

export interface ClockDto {
  durationMs: number; remainingMs: number; runningSinceMs: number | null;
  state: 'running' | 'frozen' | 'interrupted';  // interrupted: persisted running clock owned by another process
}

export interface MatchDto {
  id: MatchId; seats: [Seat, Seat]; mode: 'CAM'; phase: MatchPhase;
  ready: Seat[]; clock: ClockDto;
  pauseGeneration: number; resumeConsents: Seat[];
  judge: null | { reasons: JudgeReason[]; sinceMs: number; raisedBy: Seat[] };  // null exactly when judgeAttention is false
  proposal: null | { revision: number; winner: Seat; reporter: Seat; decision: 'open' | 'disputed' };
  finalWinner: Seat | null;
  finalSource: null | 'agreed' | 'admin';      // confirmedBy present -> agreed
  confirmedBy: Seat | null;
  adminActions: MatchAdminAction[];            // computed from the domain rules
}

export interface StandingDto { seat: Seat; points: number; rating: number }

export interface EventSnapshotDto {
  eventId: string; version: number; panelRevision: number;
  status: 'active' | 'retired'; kind: 'legacy' | 'signup';
  createdAtMs: number; retiredAtMs: number | null;
  game: string; durationMs: number; points: { win: number; loss: number };
  stage: 'signup' | 'checkin' | 'live' | 'complete';
  signup: null | { status: 'open' | 'assigned'; capacity: 4; roster: Snowflake[] };
  seats: Record<Seat, Snowflake | null>;
  adminId: Snowflake;
  members: Record<Snowflake, MemberDto>;       // roster, seats, admin, and members named in the audit
  checkins: Seat[]; published: boolean;
  matches: MatchDto[];
  standings: StandingDto[];
  adminActions: EventAdminAction[];
  discord: {
    guildId: Snowflake; channelId: Snowflake;
    matchChannels: Record<MatchId, Snowflake> | null; publicMatchRooms: boolean;
    cards: Record<CardSlot, { messageId: Snowflake | null; repostSuspended: boolean }>;
  };
}

export type ActorDto =
  | { kind: 'player'; seat: Seat }
  | { kind: 'member'; memberId: Snowflake }
  | { kind: 'admin' }
  | { kind: 'system'; source: 'timer' };      // mapped from principal_kind = 'system'

export interface CommandDto {                  // sanitized copy of the stored domain command
  type: string; matchId?: MatchId; winner?: Seat; reason?: string; memberId?: Snowflake;
  revision?: number; expectedRevision?: number; pauseGeneration?: number;
}

export interface AuditEntryDto {              // applied commands only
  sequence: number; commandId: string; occurredAtMs: number; actor: ActorDto;
  via: 'discord' | 'web' | 'system' | 'cli'; // principal_kind; null -> 'cli'
  principalId: string | null;
  command: CommandDto; result: string; mode: 'CAM' | null;
}

export type StreamEventDto =
  | { type: 'hello'; apiVersion: typeof ADMIN_API_VERSION; buildId: string; bootId: string;
      status: RuntimeStatusDto; activeEventId: string | null }
  | { type: 'change'; eventId: string; version: number; panelRevision: number;
      snapshot: EventSnapshotDto; audit: AuditEntryDto[] }
  | { type: 'status'; status: RuntimeStatusDto }
  | { type: 'heartbeat'; serverTimeMs: number };

// Wave 3
export type AdminCommandDto =
  | { type: 'publish' }
  | { type: 'signupClose' }
  | { type: 'signupReopen' }
  | { type: 'signupRemove'; memberId: Snowflake }
  | { type: 'judgeResume'; matchId: MatchId; reason: string }
  | { type: 'resolve'; matchId: MatchId; winner: Seat; reason: string }
  | { type: 'correct'; matchId: MatchId; winner: Seat; reason: string };

export interface CommandPreconditionDto {
  eventVersion?: number;                                     // publish
  match?: { matchId: MatchId; phase: MatchPhase; proposalRevision: number | null;
            finalWinner: Seat | null; pauseGeneration: number };  // judgeResume, resolve, correct
  signup?: { status: 'open' | 'assigned'; rosterSize: number };   // signup commands
}

export interface AdminCommandRequestDto {
  commandId: string;                                         // UUID v4 from the browser
  eventId: string; command: AdminCommandDto; precondition: CommandPreconditionDto;
}
export interface AdminCommandResultDto {
  applied: boolean; result: string; version: number;
  cards: 'updated' | 'pending'; roomWarning: string | null;
}
export interface PanelRefreshResultDto { cards: 'refreshed' | 'pending'; roomWarning: string | null }

export const COMMAND_CAPABILITY: Record<AdminCommandDto['type'], Capability> = {
  publish: 'event.publish', signupClose: 'signup.manage', signupReopen: 'signup.manage',
  signupRemove: 'signup.manage', judgeResume: 'match.judge', resolve: 'match.judge',
  correct: 'match.correct'
};

export type ErrorCode = 'unauthenticated' | 'forbidden' | 'bad_host' | 'bad_origin'
  | 'bad_request' | 'not_found' | 'method_not_allowed' | 'conflict' | 'rule'
  | 'unavailable' | 'too_many_requests';
export interface ErrorDto { error: { code: ErrorCode; message: string }; snapshot?: EventSnapshotDto }
```

`packages/core/src/clock.ts` exports `remainingMsAt(clock, serverNowMs)`. It counts down only in the `running` state and otherwise returns `remainingMs` unchanged.

**Derivation rules.**
- **`stage`** is `signup` while signup is open. Otherwise it is `checkin` until publication, `live` until both matches are final, then `complete`.
- **`judge`** is null exactly when `judgeAttention` is false. Otherwise its reasons, start time and raisers come from the match's audit entries since attention was last cleared by confirm, resolve or correct:
  - `dispute` from dispute commands;
  - `called` from call-judge commands;
  - `expired` from a timer expiry, or from the phase `expired`.
- **`adminActions`** follow `domain.ts`:
  - `resolve` when the phase is neither setup nor final;
  - `correct` when the phase is final;
  - `judgeResume` when the phase is paused;
  - publish, signup close, reopen and remove follow their own guards.

## Appendix B: lane brief template

Each lane agent receives:
- its absolute worktree path and branch;
- its lane section;
- the Architecture, Security, Configuration, contract and Execution plan sections;
- its exclusive paths;
- the parallel-safety rules;
- the gate commands: `npm run typecheck`, `npm test`, `npm run build`, plus the web equivalents for web lanes, and `test:e2e` only for QA lanes;
- the report format.

Each lane stops and reports instead of editing paths it does not own, adding dependencies, or changing the contract.

## Independent review (19 October 2026)

A fresh read-only reviewer examined the plan against the code. Its verdict was **ready after remedies**: one blocker and nine major findings, plus two minor groups. All remedies are now in the plan above; two items remain user decisions.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Blocker: a shared package would break NodeNext typechecking and the bot-only scripts; a changed root `build` would make `dev` depend on Vite. | Accepted. Core is a composite project built by the server's `tsc -b`, root `build` stays server-only, Vite aliases core's source, and the gate runs from a fresh worktree. |
| 2 | The console defaulted on inside the live bot before any live check. | Accepted. Off by default; notifications use isolated microtasks; a test covers a throwing subscriber; the controller gains a read-only status getter. |
| 3 | Cookies on `127.0.0.1` are shared across ports. | Accepted (also found independently). Bearer tokens in `sessionStorage`, a `fetch`-based stream, hashed sessions, dev origin limited to demo, and extra security headers. |
| 4 | Contract gaps: interrupted clocks, mislabelled judge reasons, actions the rules reject, timer actor mapping, `bigint` casts, CLI events, retired reads, `commandId`, repeating stream IDs, missing members, stale tabs, applied-only audit. | Accepted. `clock.state`, audit-derived judge details, `adminActions`, `members`, `panelRevision`, `bootId`, `buildId`, plus the mapping and listing rules. |
| 5 | Shutdown budget and leaked timers. | Accepted. `admin.close()` runs first, `Connection: close`, timers cleared, a shutdown test and a manual Ctrl+C check. |
| 6 | Launch-token lifetime against restarts. | Accepted. Valid for the process lifetime, rotate-link, rate limit, streams closed on logout and expiry, open stream counts as activity. |
| 7 | Shared Wave 1 files without an owner. | Accepted. Wave 0 adds `admin/config.ts`, the full mount interface, the core clock helper, per-lane CSS entries, Vitest shims, exact test globs, the `test:db` entry, `.temp/` in `.gitignore`, absolute reference paths, and the contract-change procedure. |
| 8 | Toolchain verified only for the npm check. | Accepted. Type packages and `@testing-library/dom` added, peer ranges verified, npm pinned exactly, single-Vite check, smoke tests, sequential worktree installs. |
| 9 | Design-system provenance. | **User decision 2.** Default: original code reproducing the look. |
| 10 | The Wave 3 path could drift from Discord's, retried successes could get 409, and the controller would be bypassed. | Accepted. One transaction body, prior-result lookup before preconditions, preconditions under the lock, everything through the controller. The admin-identity question is **user decision 4**, resolved at the Wave 2 checkpoint (see Decisions). |
| 11 | E2E runs colliding on one port or attaching to a running bot. | Accepted. Per-run ports, `reuseExistingServer: false`, prebuilt `dist`, E2E only in QA lanes. |
| 12 | Smaller fixes: health-route variants, `index.html` caching, the fixed token in Discord mode, one snapshot read per change, galleries in production builds, an inert Wave 2 composer, narrow layouts, fixture drift, and the Database page needing a separate process. | Accepted, all incorporated. |

The reviewer asked to preserve:
- the in-process API, justified by runner, lease and controller ownership, with no new tables or queues;
- a demo built on the real `transition()`;
- contract-first lanes with exclusive ownership and a dependency freeze;
- a review per wave and the checkpoint before admin actions;
- string Snowflakes and a server-authoritative clock;
- Host and Origin allowlists, no CORS, the fragment login token, JSON-only bodies and generic errors;
- `web:<uuid>` idempotency with preconditions, and `principal_kind = 'web'` needing no migration.

## Wave 1 review follow-ups (19 October 2026)

Fixed on `feat/admin-dashboard`:
- `hello` reports the status read after the first snapshot read, which can itself change the database state.
- During a database outage a stream still opens. `hello` carries `database: 'unavailable'` and `activeEventId: null`, and the snapshot follows as a `change` once a retry succeeds, either on a status change or on the 5 s tick.
- The 5 s tick no longer reads a snapshot. The runtimes' own polls report version changes; the tick re-reads only after a failed read.
- Unexpected errors still answer a generic 500 and now write one token-free line to stderr (error class, method and path).
- Health paths are matched case-insensitively and after percent-decoding, so `/LIVEZ` gets the server's 404 rather than the app shell.
- `admin.close()` drops in-flight API requests, so a slow read cannot hold shutdown past the watchdog.
- A judge wait caused by an expiry from an ordinary command is dated from the newest match command, not from kickoff.
- The web stream client's watchdog also bounds the connect.
- The stream frame encoder now lives in core (`formatStreamFrame`). The server writes with it and the web client tests read its output, so the wire format cannot drift between lanes.

Accepted and carried forward:
- **Wave 4 docs (README and `.env.example`).** `TCG_ADMIN_CONSOLE` and `TCG_ADMIN_COMMANDS` accept only 0 or 1. Discord mode refuses `TCG_ADMIN_LOGIN_TOKEN`, `TCG_ADMIN_DEV_ORIGIN` and `TCG_ADMIN_DEMO_MODE` even when the console is off, so a leftover demo value stops the bot at startup. This fails closed, deliberately.
- **Threat model.** Failed logins are limited globally (10 a minute). A local process can therefore keep the console locked; browser pages cannot, because the Origin check comes first.
- **Wave 3.** If a command can retire the active event with no replacement, the stream must tell clients that `activeEventId` is now null. Today that cannot happen: Discord mode needs the bot's lease, and the demo replaces events atomically.

## Wave 2 review follow-ups (19 October 2026)

Server, fixed on `feat/admin-dashboard`:
- The Discord runtime's safety-net poll keeps its own version baseline. Its first poll also notifies. A controller notice no longer hides an out-of-process write (the rehearsal CLI) that lands before the next poll. This gap opened when the stream tick stopped re-reading snapshots.
- A flush that started before a newer read failure can no longer clear the retry flag.

Accepted:
- When an expired match gets a later non-judge command, its judge wait is dated from the newest match command. The stored state keeps no expiry instant to date it from.

The web findings (stale retired-event cache, login fragment while signed in, needs-you wording, banner and live-region noise, pane focus return, pasted-link origin, favicon) are routed to L6, with polish rounds for L3, L5 and L7.
