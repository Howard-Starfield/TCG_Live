# TCG Live

This repository contains the local foundation for TCG Live: a loopback health server, a four-player database rehearsal, and an optional private Discord adapter. Default `dev` startup runs only the health server on `127.0.0.1`.

## Requirements

- Node.js 24.14.0 and npm 11.9.0 (`.nvmrc` and `package.json` record the runtime).
- PostgreSQL is optional for disconnected startup. A configured local database is needed for a ready response.

From the repository root, install and run:

```powershell
npm.cmd ci
npm.cmd run dev
```

`dev` builds TypeScript and runs the compiled program. To run that program directly after a build:

```powershell
npm.cmd run build
node apps/server/dist/main.js
```

Press Ctrl+C to stop the server. On Windows, the npm launcher may then ask `Terminate batch job (Y/N)?`; answer `Y` to close that launcher. The application prints `TCG Live health server stopped` after its cleanup completes.

The server listens only on `127.0.0.1:3000` by default. Set `PORT` to a free TCP port from 1 through 65535 if needed. `DATABASE_URL` is optional; an unset or whitespace value starts the server disconnected. `.env.example` shows values, but no `.env` file is loaded automatically. Set environment variables in your shell, for example:

```powershell
$env:PORT = '3000'
$env:DATABASE_URL = 'postgres://local_user:local_password@127.0.0.1:5432/tcg_live'
npm.cmd run dev
```

Use a disposable local PostgreSQL database and its own credentials for a connectivity check. The URL must contain an explicit user, password, port, database name, and exactly one loopback host (`localhost`, `127.0.0.1`, or `[::1]`). `postgres:` and `postgresql:` are accepted. Query parameters and fragments are rejected; the application does not accept remote database hosts. The health probe performs only `SELECT 1` and never provisions or migrates a database. Do not point it at another application's database.

## Health routes

| Request | Response |
| --- | --- |
| `GET /livez` | `200 {"status":"live"}` while serving |
| `GET /readyz` with no database URL | `503 {"status":"not_configured"}` |
| `GET /readyz` after successful database probe | `200 {"status":"ready"}` |
| `GET /readyz` when the database cannot answer | `503 {"status":"unavailable"}` |
| Other method on either route | `405 {"status":"method_not_allowed"}` with `Allow: GET` |
| Other path | `404 {"status":"not_found"}` |

Each readiness check has a two-second total budget. Concurrent checks share one attempt, and a later check retries after failure. Health responses and startup errors do not contain database credentials or driver diagnostics.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Tests run against compiler-emitted JavaScript with Node's built-in test runner. They cover disconnected and simulated failure states, URL rejection, process-output redaction, request routing, coalesced bounded probes, and shutdown with port reuse. These tests do not establish a successful PostgreSQL login; that requires a separately selected disposable local database. Runtime data under `data/postgres/`, backups, secrets, and generated output are ignored by Git.

## Four-player local rehearsal

Set `DATABASE_URL` in your shell to the explicitly selected disposable **`tcg_rehearsal`** database using its own local owner credentials. The URL must satisfy the loopback grammar above. No credential file is loaded automatically. Then run:

```powershell
npm.cmd run db:setup
npm.cmd run test:db
npm.cmd run rehearse
```

`db:setup` creates the base rehearsal schema only when the named database's public schema is empty. It accepts a recognized existing rehearsal schema on later runs and refuses other databases or unknown schemas. The Discord schema upgrade is a separate explicit command. `test:db` is the opt-in real PostgreSQL suite; it fails clearly without `DATABASE_URL`. Ordinary `npm.cmd test` reports the database suites as skipped.

Only **applied** commands reserve a command ID. An idempotent repeat check-in returns an acknowledgement without a new state or audit entry, so its new command ID remains available. Once an applied command uses that ID, reusing it with different actor or payload is a conflict.

Each `rehearse` run creates a new event without resetting prior events. A fresh Node child continues registration, then the parent runs one fixed BO1 CAM round with pairs A/B and C/D. The harness uses an **accelerated injected clock** for deterministic transitions; its timestamps are not wall time. It prints four players in fixture order with derived points and Elo, an event ID, and the audit count. After a run, inspect the saved event or audit without changing it:

```powershell
node apps/server/dist/rehearsal/cli.js status EVENT_ID
node apps/server/dist/rehearsal/cli.js audit EVENT_ID
```

The child process proves registration persistence across processes. Continuing an active running clock in a different process is deliberately rejected until an outage policy is defined. The fixture actor map is synthetic; these commands do not verify Discord identities, run a live tournament, or implement backups and recovery.

## Private Discord rehearsal

The optional adapter uses a private guild text channel for check-in and optionally one assigned voice-channel chat per match, four allowlisted players, one separate admin, and one fixed practice round. Configure both `TCG_DISCORD_M1_CHANNEL_ID` and `TCG_DISCORD_M2_CHANNEL_ID` to route match cards into those voice chats. Leaving both unset retains the original shared-text layout. The saved session freezes this routing with its player identities. There are three cards: pinned check-in, A/B, and C/D. Each match has a one-minute practice clock; expiry flags judge attention without choosing a winner.

Use the selected local `tcg_rehearsal` database. With `DATABASE_URL` set, create the base schema if needed and apply the additive Discord migration:

```powershell
npm.cmd run db:setup
npm.cmd run db:discord-setup
```

Set the application, guild, channel, four player and admin IDs documented in `.env.example`, then prepare a fresh session locally:

```powershell
npm.cmd run discord:prepare
```

Preparation saves the identity mapping but does not contact Discord or require a bot token. Configuration must match that saved session when running. With the bot stopped, `npm.cmd run discord:prepare -- --replace` explicitly retires the old session and prepares a new one, retaining its results and audit. This is also how to change test accounts or target. A database-wide ownership lock prevents replacement while the bot is running.

For a live rehearsal, configure the dedicated test application's token privately in the environment as `TCG_DISCORD_TOKEN` or the accepted fallback `DISCORD_BOT_TOKEN`. No `.env` file is loaded automatically by the normal commands. Keep the token out of source, shell history, command arguments, and logs. The owner must first install that application in the selected guild and grant the channel permissions listed in [the reviewed plan](docs/PRIVATE_DISCORD_PLAN.md).

These two commands contact Discord: registration updates only the guild's named `/tcg-test` command; run starts the Gateway connection and local health service.

```powershell
npm.cmd run discord:register
npm.cmd run discord:run
```

The configured admin invokes `/tcg-test refresh` to create the cards, then `/tcg-test publish` after four check-ins. Buttons handle readiness, pause/resume, result proposal/confirmation/dispute, and judge attention. Admin resolve/correct/judge-resume commands require a reason. Refresh also repairs deleted cards and retries pinning; background work only edits saved message IDs. An ambiguous send can leave an inert stray card for manual removal.

Judge attention is shown on the card without a notification ping, so the supervising admin must watch the channel. [The validation record](docs/PRIVATE_DISCORD_VALIDATION.md) lists completed checks and remaining human interaction checks. Match cards can use voice-room text chats; pinning is reserved for the check-in text channel because Discord rejected voice-chat pin requests. Pause is enabled while running and Resume consent while paused; unavailable controls remain visibly disabled, and expiry explains that judge resolution is required.

Human messages in a configured channel move its existing panels to the bottom after a short, bounded cooldown. The bot sends a replacement once, saves its canonical ID, then removes the previous bot-authored panel. It ignores bot messages, coalesces bursts, and keeps check-in pinned while removing its own pin notice. Ambiguous sends or incomplete cleanup suspend automatic reposts for that panel across restart; inspect the channel before an explicit admin refresh. This uses the Guild Messages intent without requesting Message Content. The fixture provides assigned-player check-in; open signup is a separate future flow.

Paused panels use red and show which tagged player still needs to consent. The first consent attempts one targeted reminder to the remaining player per pause generation; routine panel reposts do not repeat notifications. Other nonfinal matches use orange and final matches use green, with a winner line instead of a frozen clock. Successful button clicks acknowledge silently through the panel. Private errors and slash acknowledgments are deleted through the interaction webhook after about eight seconds while the bot is running; old messages may still need manual Dismiss.

Result reporting uses **I won**, followed by the opponent's green **Agree** or red **Dispute**. There is no **I lost** button. **Resume** is green; **🟠 Pause** uses the neutral button style with an orange indicator, since Discord has no orange button style. The panel tags the users who readied, consented to resume, reported a win, or agreed to the result. An open report disables I won; a dispute allows a corrected report. Admin rulings are not displayed as player agreements.

Pause before a planned restart. A new process can continue setup, paused, expired, or finished state, but it blocks a session containing a persisted running clock. Use explicit replacement for an interrupted practice session; running-clock recovery is deferred. A brief Gateway reconnect within the same process keeps the clock counting. Ctrl+C stops the runtime.

Project plans under `docs/` record product direction. [The B0 plan](docs/BOILERPLATE_PLAN.md) and [validation record](docs/B0_VALIDATION.md) document the health-server foundation. [The rehearsal plan](docs/FOUR_PLAYER_REHEARSAL_PLAN.md) defines the local fixture, and [its validation record](docs/REHEARSAL_VALIDATION.md) explains how to reuse the native PostgreSQL target on this workstation. [The private Discord plan](docs/PRIVATE_DISCORD_PLAN.md) and [review decisions](docs/PRIVATE_DISCORD_REVIEW.md) define this adapter's scope. Use the [future test checklist](docs/FUTURE_TEST_CHECKLIST.md) for the next Discord regression pass and signup work. Multi-round tournaments, global ratings, and recovery remain later work; the local admin console is described [below](#local-admin-console).

## Private signup and roster

Signup uses the same private channel and voice-chat panels with four roster slots and a separate organizer. Configure the installation, channels and admin as above, but leave all four `TCG_DISCORD_PLAYER_*_ID` variables unset. Signup mode refuses preset players. Prepare while the bot is stopped, then run:

```powershell
npm.cmd run discord:signup-prepare
npm.cmd run discord:signup-register
npm.cmd run discord:signup-run
```

For a fresh practice event, `signup-prepare --replace` explicitly retires the old session while retaining its event and audit history. `signup-register` updates only the named guild command with organizer controls. The channel's existing private audience controls who can reach signup; signup does not change permissions.

The organizer uses `/tcg-test refresh` to create panels. Players Join or Withdraw; the organizer cannot join. `/tcg-test signup-close` requires four players, assigns their signup order to the A–D practice positions, and opens separate attendance Check in. Publish still requires all four check-ins. `/tcg-test signup-reopen` clears attendance and assignment before publication while retaining the roster. `/tcg-test signup-remove` removes an entry while signup is open. Pairing, additional rounds and a waitlist remain outside this slice. See [the reviewed signup plan](docs/SIGNUP_ROSTER_PLAN.md) and [validation boundaries](docs/SIGNUP_ROSTER_VALIDATION.md).

## Public match rooms and automatic placement

Set `TCG_DISCORD_PUBLIC_MATCH_ROOMS=1` before preparing a new session to opt in. Both configured match IDs must be distinct guild voice channels named with the `TCG Match ` prefix, outside the guild's AFK channel. Use dedicated bot-managed rooms: the bot replaces their complete permission-overwrite lists. Everyone can view, connect and read history; only the current pair, organizer and bot can post. Match buttons still enforce saved participant identities. Server owners and Administrator roles bypass Discord room restrictions. Ordinary moderator-role exceptions are not retained automatically.

The bot needs Manage Roles (channel permission management), Manage Channels, Move Members and its usual text/connect permissions in both rooms. The explicit bot overwrite retains management access. Before its first change, the bot saves the original overwrite list under ignored `data/discord-room-overwrites/`. Disabling the setting later does not restore privacy; restore permissions deliberately from that backup. The setting is frozen with session routing, so changing it requires the bot to be stopped and a new prepared session. Retired events and audit records are retained.

After Publish, already-connected players move to their assigned unfinished match. A disconnected player stays disconnected and is placed when they later join voice. The bot ignores spectators, the organizer, the AFK channel, mute/deafen-only changes and finished matches. A player can disconnect voluntarily. Repeated switching is limited to three placement attempts per minute with an organizer warning. No voice/audio library or polling service is used.

Admin Refresh retries failed room-policy updates. Permission failure does not roll back an already-saved roster or result, and it does not bypass database button authorization. See [the reviewed room plan](docs/PUBLIC_MATCH_ROOMS_PLAN.md) and [the return test list](docs/RETURN_TEST_LIST.md).

## Discord visuals

Panels, resume reminders, organizer notices and private responses use small original trainer-orb PNG/GIF thumbnails. Each state has a distinct badge; the existing text, mentions, deadline and buttons still describe the actual match. Successful button clicks remain silent, and private errors retain their eight-second deletion. Animation is decorative and works with clients that display only a still frame.

Artwork is packaged in `apps/server/assets/discord/`; the bot needs Attach Files and Embed Links in its configured channels. Ordinary edits retain the current image, while state changes replace it and sticky reposts upload one visual for the new message. No image-hosting service or runtime image generator is required. Source SVGs and the optional development-only generator are included. See [the artwork overview](apps/server/assets/discord/visual-contact-sheet.png), [the reviewed visual plan](docs/DISCORD_VISUAL_PLAN.md), and [verification](docs/DISCORD_VISUAL_VALIDATION.md).

## Local admin console

A browser console for the organizer: the signup, check-in and match stages, the live match diagram, players, matches, the audit log, Discord card status, and (opt-in) admin actions. It is served by the bot process itself on `127.0.0.1` at the health server's `PORT`, so nothing else needs to run. It is localhost-only; other sign-ins are later work.

Try it without Discord or PostgreSQL first:

```powershell
npm.cmd run admin:demo
```

The demo builds the web app, plays a scripted four-player event with the real domain rules, and prints an `Admin console: http://127.0.0.1:<port>/#login=...` link. The link stays valid until it is rotated or the process restarts, so keep it private. Open it; the token is exchanged for a session and removed from the address bar. The demo always allows admin actions. Run `$env:TCG_ADMIN_DEMO_MODE = 'interactive'` first to make the script stop wherever an organizer decision is needed (remove, close signup, publish, judge-resume, resolve the disputed match, resolve after an expiry, and an optional correction in a 60-second hold before the event restarts). Run `Remove-Item Env:TCG_ADMIN_DEMO_MODE` before starting the Discord runtime in the same shell.

The main window is the console: the stage stepper, the *Needs you* decision cards, the activity stream and, when actions are enabled, the command box. The *Live preview* and *List preview* toggles at the top (Alt+1 and Alt+2) open the live match diagram and the Players, Matches, Audit and Discord tabs beside it, or in a sheet on narrow windows. Retired events stay readable under History.

With the Discord runtime, the console is off until enabled:

```powershell
npm.cmd run build:web             # the console's web assets (admin:demo builds them itself)
$env:TCG_ADMIN_CONSOLE = '1'      # serve the console (read-only)
$env:TCG_ADMIN_COMMANDS = '1'     # optional: let the console act as the configured admin
npm.cmd run discord:signup-run    # or discord:run
```

The bot prints the console link at startup. Sessions last at most 12 hours and end after 2 idle hours; *Rotate console link* in the account menu prints a fresh link and invalidates the old one. Failed sign-ins are limited to 10 a minute across all clients; rotating the link does not end existing sessions.

Admin actions (publish, signup close/reopen/remove, judge-resume, resolve, correct, panel refresh) are off unless `TCG_ADMIN_COMMANDS=1`. With it off, the console only reads and shows no action controls. With it on, a console action is the same command as the matching `/tcg-test` subcommand: it goes through the same transaction, gates, card refresh and match-room sync, needs a reason where the slash command does, and is audited as `via console` (`principal_kind = 'web'`). Each action carries the state the organizer saw; if the event changed meanwhile, the console shows the fresh state and asks again rather than applying it. Retrying an action that already succeeded returns the original result.

Configuration is strict and fails closed. `TCG_ADMIN_CONSOLE` and `TCG_ADMIN_COMMANDS` accept only `0` or `1`. The demo-only variables `TCG_ADMIN_LOGIN_TOKEN`, `TCG_ADMIN_DEV_ORIGIN` and `TCG_ADMIN_DEMO_MODE` stop the Discord runtime at startup when set, even with the console off, so a leftover demo value cannot reach a live session. Ctrl+C ends open console streams and exits cleanly.

`TCG_ADMIN_CONSOLE` stays off by default until a live Discord check with the console enabled is recorded. See [the console plan](docs/ADMIN_DASHBOARD_PLAN.md) and [its validation record](docs/ADMIN_DASHBOARD_VALIDATION.md), which separates what is proven offline from the pending live checks.
