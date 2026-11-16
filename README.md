# TCG Live

This repository contains the local foundation for TCG Live: a loopback health server, a four-player database rehearsal, and an optional private Discord adapter. Default `dev` startup runs only the health server on `127.0.0.1`.

## Windows one-click startup

On x64 Windows 10/11, extract the project into a writable folder and double-click **Start TCG Live.bat**. First launch downloads checksum-pinned private Node/npm and PostgreSQL when needed, installs application dependencies, creates its local database and applies the supported schema updates. Later launches reuse the installation and start the database if stopped. Internet is needed for missing downloads; no separate PostgreSQL service or global PATH changes are required. If PostgreSQL reports a missing Microsoft runtime, startup downloads the pinned, Microsoft-signed Visual C++ installer and Windows may request administrator approval. A denied prompt or required reboot is reported instead of bypassed.

The bot token and Discord permissions still belong to the organizer: put the token in the ignored `.env` settings file, invite the bot to your server, then use dashboard onboarding to select channels. The first launch creates `.env` from the blank example only if it does not exist. Existing settings are preserved. This is a source-folder bootstrap, not a signed Setup.exe installer; clean Windows VM/UAC verification remains on the release test list.

## Developer requirements

- Node.js 24.15.0 or newer within 24.x and npm 11.9.0 (`.nvmrc` and `package.json` record the runtime).
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

## Creating the Discord bot

1. Create an application at <https://discord.com/developers/applications> (New Application).
2. Open **Bot** → **Reset Token**, copy it and paste it into the local `.env` as `DISCORD_BOT_TOKEN=` (or `TCG_DISCORD_TOKEN=`). Never share it, paste it in chat or commit it; if it leaks, reset it again.
3. On the same page, **Privileged Gateway Intents**: switch on **Server Members Intent** only if you use the join/leave log, welcome messages or auto-role, and **Message Content Intent** only for the message log and full ticket transcripts. Presence Intent is not needed.
4. Invite the bot with the **Grant permissions** link (scopes `bot` and `applications.commands`) instead of ticking permissions by hand, then press Authorize. The setup wizard's Readiness step and **Admin tools → Settings → Bot permissions** show the link; it asks only for what your enabled features need (a second link covers every feature). Re-authorizing an installed bot updates its role.
5. After inviting, open **Server Settings → Roles** and drag the bot's role above every role it should give (button roles, auto-role, bulk role jobs). The invite cannot change role order, and roles managed by an integration can never be given by a bot.
6. Optional helper voice bots: invite each helper application the same way with its own client ID; they only need View Channel and Connect in the match rooms (`permissions=1049600`).

The dashboard re-checks permissions after role, channel, server and settings changes, shows blocking problems in a banner, and lists each gap with what breaks and how to fix it. A channel's own permission settings can still deny something the server grants; fix those in the channel's Permissions. The table below mirrors the list the checker uses (`apps/server/src/permissions/table.ts`); change both together.

| Feature | When | Permissions | Where |
| --- | --- | --- | --- |
| Tournament | Signup/control text channel | View Channel, Send Messages, Read Message History, Embed Links, Attach Files | That channel |
| Tournament | Signup tournaments | Pin Messages | Signup channel |
| Tournament | Each match voice room | View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Connect | Each room |
| Tournament | Public match rooms | Manage Permissions, Manage Channels, Move Members | Each room |
| Tournament | Rounds with more than two matches | Manage Channels, Manage Roles | Server |
| AutoMod keyword filters | Text moderation enabled | Manage Server | Server |
| AutoMod keyword filters | A keyword list uses the timeout action | Timeout Members | Server |
| Voice monitoring | `TCG_DISCORD_VOICE=1` and monitoring on | View Channel, Connect (joins self-muted; no Speak) | Each match room |
| Voice monitoring | Same | Send Messages (monitoring notice) | Each match room |
| Voice monitoring | Discord notice channel set | View Channel, Send Messages | Notice channel |
| Evidence | Discord submissions | None beyond the slash command | — |
| Moderation tools | Always | Ban Members; Kick Members; Timeout Members; View Audit Log (outside actions in history) | Server |
| Moderation tools | Always | Manage Roles (channel lock), Manage Channels (slowmode), Manage Messages + Read Message History (purge) | Server |
| Cases | Case log channel set | View Channel, Send Messages | Case log channel |
| Sticky messages | Each enabled sticky | View Channel, Send Messages, Read Message History (+ Embed Links with an embed) | Each sticky channel |
| Tickets | Tickets enabled | View Channel, Send Messages, Embed Links, Read Message History | Support channel |
| Tickets | Tickets enabled | View Channel, Manage Channels, Send Messages, Read Message History, Embed Links, Attach Files | Ticket category |
| Roles | Button roles, bulk role jobs or auto-role | Manage Roles, and the bot's highest role above each role it gives | Server / role order |
| Tournament roles | Always (setup wizard, Admin tools > Settings > Tournament roles) | Manage Roles, to create the TCG Organizer and TCG Judge roles and give them to members | Server |
| Tournament roles | Each saved TCG Organizer and TCG Judge role | The bot's highest role above each of them (they are created directly under it) | Role order |
| Tournament roles | Until both roles exist | Nothing: a warning that only the server owner and the dashboard act as organizer in Discord until the roles are created | Server |
| Roles | Each button role panel | View Channel, Send Messages (+ Embed Links with an embed) | Panel channel |
| Announcements | Each scheduled announcement | View Channel, Send Messages (+ Embed Links with an embed) | Target channel |
| Announcements | @everyone switch or a non-mentionable role ping | Mention @everyone, @here, and All Roles | Target channel |
| Logging | Join/leave log enabled | View Channel, Send Messages, Embed Links (+ Server Members Intent) | Log channel |
| Logging | Welcome message enabled | View Channel, Send Messages (+ Server Members Intent) | Welcome channel |
| Logging | Message log enabled | View Channel, Send Messages, Embed Links in its channel; View Channel in every logged channel (+ Message Content Intent) | Log channel / logged channels |

## Guided Discord startup

After installing dependencies and preparing the local rehearsal database, double-click **Start TCG Live.bat** in the project root, or use `npm.cmd start`. The Windows launcher selects a supported Node/npm installation. An initial launch builds the dashboard and server, loads the root `.env`, connects the bot, and opens the authenticated dashboard in your default browser without typing a token. Repeated launches verify and reuse this project's instance before building; an open dashboard stays single. Closing the browser leaves the bot running, and another launch reopens the dashboard after the short ten-second launch cooldown. Use `npm.cmd start -- --no-browser` to disable browser opening; a private login link remains in the terminal. Treat that link like a password.

Guided dashboard sessions do not expire from idle time or elapsed hours. Sign out, session eviction and stopping the process still end access. Keep the bot's terminal running and press Ctrl+C for a clean stop. No Windows service is installed. Ignored `data/guided-instance.json` contains local instance credentials; do not share it. A stale dead owner's record is recovered safely; an unknown occupied port is refused rather than starting another bot.

Set `DISCORD_BOT_TOKEN` (or `TCG_DISCORD_TOKEN`) privately in `.env`. Leave `DATABASE_URL` unset for the app-managed database. An explicit URL is managed only when it exactly matches this checkout's saved managed or legacy local credentials; unrelated explicit URLs are not started or provisioned by the launcher, but `npm start` still runs the idempotent schema setup and upgrades against them (the URL must name the `tcg_rehearsal` database). If that fails, the message says why and lists the manual steps: `npm run db:setup`, `npm run db:discord-setup`, `npm run db:directory-setup`, `npm run db:evidence-setup` and `npm run db:admin-tools-setup`. Generated credentials stay in ignored `data/local-database.json`; existing legacy credentials and data are preserved. PostgreSQL binds to loopback only and may remain running after the dashboard closes; the next launch verifies and reuses it. Do not delete `data/postgres` or credential files to troubleshoot a startup error. The older `dev` and direct Discord commands retain their existing environment behavior.

On first use, onboarding lists the bot's servers and available channels, asks for the separate organizer, signup text channel and two match voice rooms, and checks effective permissions. Give the bot View Channel and refresh if a channel is missing. New events use dedicated non-AFK rooms named with the `TCG Match ` prefix. Public rooms also require Manage Permissions, Manage Channels and Move Members. The signup channel receives an owned setup-status message; missing permissions include a repair guide. Uncertain delivery is shown for manual inspection rather than automatically sending duplicates.

An active saved event locks its existing identity and routing; **Save and Start resumes it**, preserving roster, results and audit history. Without an active event, that button prepares one signup event and initializes its panels. Setup settings contain only non-secret IDs and guide-message bookkeeping in ignored `data/discord-setup.json`. Later healthy starts open the normal dashboard directly. The handover opens a new authenticated dashboard session; the old setup tab can be closed. Save and Start also creates the two staff roles (see *Roles and staff* below) and gives **TCG Organizer** to the organizer you chose; the result is shown in the wizard, and a role problem (for example a missing Manage Roles permission) never stops setup. The wizard ends with a **What's next** step that says where Admin tools, Moderation & evidence, helper bots, LFG and the capabilities page live.

### Dashboard options (npm start)

The Readiness step and **Dashboard options** in the sidebar hold two switches, saved in `data/discord-setup.json` next to the setup choices (`GET`/`PUT /api/v1/settings/local`, any signed-in loopback session, audited as `local.settings` in the operations audit and in `data/local-settings-audit.jsonl`):

- **Allow dashboard actions** (on by default, also for profiles saved before this switch existed) gives the session every capability `TCG_ADMIN_COMMANDS=1` grants: publish, signup changes, judging and corrections, opening or deleting tournaments and drafts, server tools. Capabilities are re-read on every request, so a change applies to open tabs at once. When it is off, a banner says what is hidden and offers **Turn on**.
- **Voice monitoring** (off by default) replaces editing `TCG_DISCORD_VOICE`. It is read when the bot starts; a banner asks for a restart after a change.

Precedence: `1` in `.env` (or the shell) forces a setting on and locks its switch. `0`, blank or unset defers to the switch. Every guided install copied `=0` from `.env.example`, so `0` cannot mean "forced off"; turn the switch off to keep the dashboard read-only. Direct commands (`npm run discord:run` and the like) never read the switches: there `TCG_ADMIN_COMMANDS` and `TCG_DISCORD_VOICE` alone decide, as before.

The sidebar has independent Live/History disclosure arrows, a transparent scrollbar track and small date labels beneath names. Search uses PostgreSQL full-text prefix matching over saved tournament names, games and status. The inline **+** opens **Create signup tournament**. Choose a game type and title, set the match timer (30 minutes by default), and choose the signup banner and Discord text channel. The last live tournament for each game supplies editable banner and channel defaults. Add optional details for the Discord signup panel. Choose **Create** to open signup or **Save as draft** to continue later. **Drafts** lists saved drafts. Use **Open signup** on a saved draft when ready. If a tournament is active, confirmation moves it to History. Match panels stay in their assigned rooms, and signup goes to the selected text channel. Finish any published round before switching. Use **Refresh panels** if Discord delivery is pending.

Use **Edit tournament details** on the live event to save its title, game and optional description (up to 500 characters). Saving selects the matching game banner and updates existing Discord panels. These are presentation settings; the current four-player BO1 camera-play test rules stay fixed. The signup banner shows player counts, with **View roster** immediately after **Withdraw** opening a private roster response. Details persist against the active tournament ID and its name is searchable in the sidebar. Restart with `npm start` (or run `npm run db:directory-setup`) after upgrading to apply the additive description column; existing event aggregates and audit rows are preserved.

Click **Edit signup banner** in the live event, or open the account menu → **Game artwork…** to preview One Piece, One Punch Man or Pokémon, upload a tournament banner or compact thumbnail, restore defaults and choose the active game's artwork. Signup/check-in use the banner; match cards, reminders and notices use the optional thumbnail, with original state artwork as fallback. Selecting a game, uploading or resetting its active artwork automatically updates existing Discord panels. Inactive game uploads are saved until selected. The dashboard reports applied or pending delivery; use **Update signup banner** to retry, or **Refresh panels** to repair missing panels. Artwork changes do not create messages or change tournament rules.

Uploads accept GIF, PNG and JPEG up to 4 MiB, 4096 pixels per side and 16 megapixels. Runtime settings/uploads stay in ignored `data/artwork/`, separate from [the packaged defaults](apps/server/assets/games/README.md). Storage is capped at 64 MiB; old immutable versions are retained for safe in-flight sends, so archive unused versions locally if the budget is reached. Corrupt settings fall back to original artwork with a dashboard explanation and remain untouched until an explicit save. Type/dimension/header checks do not fully decode the image; a corrupt image may still fail display.

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

These two commands contact Discord: registration upserts the guild's `/tcg-test`, `/tcg-staff` and `/tcg-admin` commands (run also does this on every start); run starts the Gateway connection and local health service.

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

The bot prints the console link at startup. Direct-command and demo sessions last at most 12 hours and end after 2 idle hours; guided `npm start` / Windows-launcher sessions stay signed in while the process runs. *Rotate console link* in the account menu prints a fresh link and invalidates the old one. Failed sign-ins are limited to 10 a minute across all clients; rotating the link does not end existing sessions.

Admin actions (publish, signup close/reopen/remove, judge-resume, resolve, correct, panel refresh) are off unless `TCG_ADMIN_COMMANDS=1`. With it off, tournament command controls are hidden; authenticated artwork editing remains available. With it on, a console action is the same command as the matching `/tcg-test` subcommand: it goes through the same transaction, gates, card refresh and match-room sync, needs a reason where the slash command does, and is audited as `via console` (`principal_kind = 'web'`). Each action carries the state the organizer saw; if the event changed meanwhile, the console shows the fresh state and asks again rather than applying it. Retrying an action that already succeeded returns the original result.

Configuration is strict and fails closed. `TCG_ADMIN_CONSOLE` and `TCG_ADMIN_COMMANDS` accept only `0` or `1`. The demo-only variables `TCG_ADMIN_LOGIN_TOKEN`, `TCG_ADMIN_DEV_ORIGIN` and `TCG_ADMIN_DEMO_MODE` stop the Discord runtime at startup when set, even with the console off, so a leftover demo value cannot reach a live session. Ctrl+C ends open console streams and exits cleanly.

`TCG_ADMIN_CONSOLE` stays off by default until a live Discord check with the console enabled is recorded. See [the console plan](docs/ADMIN_DASHBOARD_PLAN.md) and [its validation record](docs/ADMIN_DASHBOARD_VALIDATION.md), which separates what is proven offline from the pending live checks.

### Capabilities & shortcuts

*Capabilities & shortcuts* (sidebar, or the account menu) lists everything the bot and the console can do, grouped by area: the exact Discord command or button, the dashboard place (click it to go there), who may use it, what Discord must allow, and a live status (*Available*, *Needs setup* with the fix, or *Turned off*). Search filters the list. Press `?` anywhere (except while typing) for the keyboard shortcuts. Console pages have addresses: `#/capabilities`, `#/admin-tools/<tab>` and `#/admin-tools/<tab>/<item>` (for example `#/admin-tools/cases/12` or a ticket's transcript), so a reload keeps your place. They never clash with the `#login=` link.

### Admin tools

*Admin tools* (sidebar) acts on the configured Discord server: **Members** (search, profiles with cases, private notes and tournament history), **Bans**, **Cases** (numbered warn / timeout / kick / ban cases with reason and evidence, plus the mod-action audit trail), **Stickies**, **Channels** (lock, slowmode, purge), **Tickets** (the *Create ticket* panel, transcripts, close and reopen), **Roles**, **Announcements**, **Logs** (join/leave and message logs, welcome message, auto-role with a *Skip bots* switch) and **Settings**. Reading needs `members.read`; changes need `members.moderate` or `server.manage`, and every change is audited. Members can also be moderated in place: the gavel menu on the Players and Matches tabs, the *Moderate* button on Needs-you judge cards, the Flags tab and the Evidence drawer opens the same confirm dialog, with the tournament, match and evidence attached to the case.

Cases, the event audit, the evidence & moderation audit, Logs, ticket transcripts and Flags have **CSV** and **JSON** export buttons. The file is made in the browser from the API, up to 5,000 rows; when there were more, the export says so (narrow the filters and export again). CSV cells that a spreadsheet would run as a formula are prefixed with `'`.

### Evidence

Players attach a clip (up to 100 MB) or a link to their match with `/tcg-test evidence match:M1 file:<attachment> link:<https://…> note:<text>`; the bot records voice per player as Ogg files when recording is on. In the console, *Evidence* on a match (Matches tab, Needs-you cards, Flags) opens the drawer: play or download, add a file or link, *Hold* (held items are never deleted automatically), delete with a reason. Each item shows its **ID** with *Copy*, and *Attach to case…* adds it to an existing case of one of the match's members (up to 10 per case) or opens a new case with it attached. In a case's details, a case from a match lists that match's evidence as checkboxes instead of raw IDs.

### Moderation

*Moderation & evidence* (account menu or sidebar) sets the AutoMod keyword lists (with *Sync*), voice loudness, recording mode, retention and the notice text. The **Flags** tab (List preview) shows AutoMod keyword hits and loud voice moments; *Acknowledge* (seen, handled) or *Dismiss* (not a problem) each flag, reopen it later, and filter by *Open*. Reviews are audited as `moderation.flag.reviewed` (`PATCH /api/v1/moderation/flags/:id`; existing databases get the new columns when the launcher or `npm run db:evidence-setup -w @tcg-live/server` reapplies the evidence setup). The demo (`npm run admin:demo`) seeds sample flags, an evidence link, a short voice file, cases and tickets with transcripts so every screen has data.

### Discord commands, tournament staff and tempbans

The bot registers (or updates) its guild commands on **every start**; a command whose definition has not changed is left alone. Existing installs therefore pick up new subcommands after a restart. The structure is:

| Command | Who sees it | Subcommands |
| --- | --- | --- |
| `/tcg-test` | everyone | `evidence`, `recording-optout` (opt out of or back into match audio recording) |
| `/tcg-staff` | everyone (the bot decides who may run each subcommand) | `publish`, `signup-close`, `signup-reopen`, `signup-remove`, `signup-add`, `checkin-for`, `refresh`, `resolve`, `correct`, `judge-resume`, `judge-close`, `evidence-reply` |
| `/tcg-admin` | Manage Server by default | `status`, `warn`, `timeout`, `untimeout`, `kick`, `ban` (optional `duration` = temporary ban), `unban`, `case`, `note`, plus the admin-tools features |

The tournament subcommands kept their names: what used to be `/tcg-test publish` is now `/tcg-staff publish`. `resolve`, `correct` and `judge-resume` work for any match (M1…Mn): the match and winner options suggest the live matches and their seated players, and typed text (`M3`, `B`, or a mention) is checked. `checkin-for` accepts a seat or a mention. `judge-close` (options `match` and `note`) closes a judge request with a note, like the dashboard's *Close request*. `evidence-reply` (options `match`, `text` and `staff-only`, default off) adds a text reply to a match's evidence thread: it is delivered to Discord like a dashboard reply, mentions only the players seated in that match, and is recorded in the audit. The console composer understands the same commands, including `/signup-add` and `/checkin-for`.

**Roles and staff.** The bot manages two Discord roles, created with no permissions and placed directly under the bot's highest role:

| Role | May do |
| --- | --- |
| **TCG Organizer** | Everything staff can do: publish, signup close, reopen, add and remove, delay or start, refresh, check-in-for, rulings (`resolve`, `correct`, `judge-resume`, `judge-close`), evidence submit and reply, and `/tcg-admin` status and moderation. |
| **TCG Judge** | Rulings only: `resolve`, `correct`, `judge-resume`, `judge-close`, `checkin-for`, evidence submit and `evidence-reply`. A judge can never publish, run signup, delay, start, end, retire or delete a tournament, change settings, moderate or refresh. |

- **The server owner always counts as Organizer.** The old organizer Discord ID from setup is no longer a staff source on its own; it stays the contact mention, the room-access identity and the identity behind the dashboard. Setup gives TCG Organizer to the organizer you pick (the server owner by default).
- **Legacy staff roles** (*Admin tools > Settings > Cases > Tournament staff roles*) count as TCG Judge. Give TCG Organizer to anyone who needs more.
- **Manage them** in *Admin tools > Settings > Tournament roles*: rename, recolour, add and remove members. Setup creates the roles; existing installs get them from the **Create TCG roles** button, because roles are never created automatically while the bot runs. Until the roles exist, only the server owner and the dashboard act as organizer in Discord, and the bot permission banner says so. The bot only ever adopts a role by the ID it saved in `data/discord-setup.json`, never by name, and never gives out a role that is managed by an integration, above the bot, or carries staff permissions. Without the Server Members intent the member lists may be incomplete and say so.
- **Organizers can play.** Being staff never bars joining signup. A staff member seated in a match cannot rule on that match (`resolve`, `correct`, `judge-resume`, `judge-close`, evidence replies, evidence hold and delete), and neither can the dashboard when its organizer identity is seated there; another organizer or judge must. Closing signup warns when no other staff member can be confirmed.
- **Visibility.** `/tcg-staff` is visible to everyone, because the bot checks the role on every use and answers a refusal privately. `/tcg-admin` keeps Manage Server. Members with the matching Discord permission (Ban Members for `ban` and `unban`, Kick Members for `kick`, Timeout Members for the rest) may run the moderation subcommands too; a TCG Judge may not.
- **Audit.** Actions record who did them: the real Discord user is stored as the principal with a snapshot of their name and role (`organizer:<id>` or `judge:<id>`). Dashboard actions show as *Dashboard (local admin)*.

**Temporary bans.** A ban with a duration (Discord `duration:1d`, or *Ban length* in the Members ban dialog) stores its end on the case. The bot lifts it when it ends: it checks on start (catch-up after a restart) and then every minute. Each lift opens an `unban` case by the bot and writes `member.tempban_expired`. A later ban of the same member replaces the expiry. The PC must be on for the lift to happen on time.

**Match cards.** While a match needs a judge, is disputed, and for 24 hours after its result, the card shows **Submit evidence**. The two players and staff get a form with a file upload, a link and a note. When the voice runtime records a match room, its card shows "🔴 Audio recording active". When the recording mode is not *off*, the signup card states the recording policy and points to `/tcg-test recording-optout`.

## LFG (looking for a game)

Admin tools → **LFG** lets members find opponents. Pick one or more LFG channels (each may have its own panel, allowed games, ping role and voice rooms), list the games (with an optional emoji and ping role) and formats, and save. The bot keeps a *Looking for a game* panel at the bottom of each LFG channel. Its button opens a form with the game, the format, a note and an optional voice room, and posts a card with **Join**, **Leave** and **Close** buttons. The card lists who joined, showing a set number of names and then "+N more". There is no cap on players.

- **Limits.** Cards close themselves after the set time (30 min to 24 h), and closing catches up after a restart. Each member has a posting cooldown and a maximum number of open posts (0 = unlimited). Only the author or staff with Manage Messages can close a card. A card deleted by hand marks its post deleted.
- **Ping.** The optional LFG role, per channel or per game, is pinged when a card is posted, at most once per ping cooldown. Only that role can be notified (`allowedMentions`). Member text is escaped, so a note cannot ping, format or fill in placeholders.
- **Messages.** Every member-facing text is customisable, with live previews: the panel title, text, colour, button label and emoji, the form labels and placeholders, the card template, the closed and expired texts, the private replies, and the ping text. Templates use `{author} {game} {format} {note} {voice} {count} {players} {expires}`, and the ping text also uses `{role}`. Saving is refused when a template could exceed a Discord limit with the longest possible values.
- **Dashboard.** The tab shows panel status (with *Post / refresh panels*), the posts filtered by status and game (close, delete), and posts and joins per game. Every change and every Join, Leave, Close and expiry is audited (`lfg.*`).
- **Restrictions.** LFG channels may not be tournament channels, a channel with a sticky message, or the ticket support channel.
- **Storage.** Settings and posts live in migration `014_lfg.sql`, which `npm run db:admin-tools-setup` and the launcher apply after 013.
- **Permissions.** The bot needs View Channel, Send Messages, Embed Links and Read History in each LFG channel, and Mention Everyone only if the ping role is not mentionable.
