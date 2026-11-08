# First-start dashboard and Discord channel setup

Requested 7 November 2026. Keep the existing console's design and four-player practice scope. Artwork uploads are separately queued in [GAME_VISUALS_QUEUE.md](GAME_VISUALS_QUEUE.md).

## User flow

`npm start` becomes the guided front door: load a local `.env` without exposing its values, open an authenticated localhost dashboard in the default browser, and guide the organizer through server, signup text channel, two dedicated match voice rooms and permission checks. Existing direct rehearsal/demo commands remain available and keep their behavior. Browser opening is best effort with an explicit headless opt-out and the existing private terminal link as fallback.

The bot discovers the servers it belongs to and lists the channels Discord returns, grouped by category and type. Only text channels can be signup destinations; match destinations are distinct dedicated voice rooms, not AFK. Explain that missing channels may need View Channel permission before the bot can discover them. No message contents, privileged member-list intent or extra OAuth sign-in is needed. The organizer ID is explicit, with the selected server owner as a convenient default; the organizer stays separate from players.

The final screen checks effective permissions and shows the exact room, bot identity, missing capability and guide: Edit Channel → Permissions → add/select BoBoAssist itself → Manage Permissions green Allow → Save Changes. Show current permission status, not merely that the user said it was enabled. The selected signup channel receives an owned, updatable setup warning with the same guide when the bot can post there. If it cannot post, explain that limitation in the dashboard and keep the guide visible there.

## Chosen boundary

Use a small bootstrap phase before the existing Discord runtime, reusing the existing authenticated admin HTTP/static server and web UI components. Add setup DTOs and optional setup routes/session marker rather than introducing a new account system, public server or generic task framework. Setup writes are configuration actions for the authenticated local organizer; they do not turn on match commands. `TCG_ADMIN_COMMANDS` remains the existing opt-in.

The bootstrap logs in only to discover/validate Discord configuration, then hands over to the existing runtime after Save and Start. A controlled local restart/handover and a new authenticated dashboard tab are acceptable for this first slice; the UI says setup is complete and the dashboard is opening. Do not refactor the existing controller, lease and runtime into a new application lifecycle framework solely to avoid that handover.

Store only validated non-secret IDs/settings plus owned warning-message bookkeeping in an atomically written, Git-ignored `data/discord-setup.json`. Do not let the browser read or write `.env`, tokens or connection passwords. Match source/default assets remain unchanged. No new SQL tables or schema migration.

## Resume and first event

The existing active session is authoritative. Reconstruct its frozen config from the database, verify the authenticated bot application matches, preselect its server/channels/admin/mode and lock changes that would conflict with it. Continue resumes that event; never use `prepare --replace`, retire history or insert fake players. Keep existing legacy fixtures compatible.

With no active event, validate the user's selection again server-side and prepare one new signup event only after explicit Save and Start. If another process wins the lease or creates an event, fail closed and ask the user to review/resume it. Never nest the existing prepare function inside a lease it must acquire itself. Database/token configuration failures remain visible setup prerequisites, with actionable instructions; no PostgreSQL installer or power-setting changes are included.

If saved configuration is healthy on a subsequent start, open the live dashboard directly. If permissions/configuration need attention, open setup with those saved selections. Do not silently switch public/private mode or room routing for an active event. New public-room setup requires the management/movement capabilities; an existing private fixture may resume privately with a clear public-room warning.

## Warning delivery

Maintain one warning message for the selected signup channel using its saved bot-authored message ID. Edit it as diagnostics change, including a resolved state. Recreate only after a confirmed Unknown Message; do not automatically retry an ambiguous send or create a new warning on every refresh/start. Persist a pending-send marker before the first POST and surface uncertain delivery for manual review. Never edit/delete another author's message. Use text-only fallback if Embed Links/Attach Files are missing but Send Messages is available. Mention only the organizer when a new actionable warning is first sent; routine edits never ping again.

## Design

Subject: an organizer connecting a Discord tournament to its rooms. The page's job is to choose and validate destinations, not sell the product. Reuse existing dashboard fonts, warm surfaces, accent, fields/buttons, focus and mobile behavior. A real three-step progress rail encodes Server → Channels → Readiness. The signature is a compact readiness map showing signup, M1 and M2 with actual channel names and missing permissions. Avoid unrelated theme/motion changes.

Compared alternatives: editing `.env` from the browser is unnecessary secret/config coupling; a local non-secret settings file is simpler. Splitting the entire runtime into a permanent mutable bootstrap/running engine would avoid a second tab but increases lifecycle risk; reuse the existing runtime through a bounded handover instead.

## Verification

Test authenticated setup routes/Host/Origin boundaries; real server-side channel/guild/type checks; effective permission diagnostics; token absence and DB failure; profile whitelist/atomic persistence; warning deduplication, ownership and ambiguous sends; browser launch arguments and opt-out; active-session resume/no replacement; fresh signup preparation; and match-command opt-in preservation. Test the wizard with keyboard and narrow layouts using existing UI patterns. Run affected/full unit checks and relevant existing browser/native suites. Verify the real server channel list and permission guide without fake signup accounts; preserve existing event/audit history. Full four-player live play remains pending additional people.

## Inspection and implementation notes

Luna checked the chosen plan against current source. Add an explicit root `start` script; none exists today. The guided launcher must explicitly mount the console, whose old default is off. The existing direct commands and match-command opt-in retain their defaults. Optional `SessionDto.setup?: true` is a bootstrap display marker, not a grant of match-command capabilities; setup routes exist only when the authenticated setup service is mounted. A small empty bootstrap runtime can satisfy the existing status/event interface while setup is shown, with no fake events.

The new entry may load `.env` for the guided command, without changing the old commands' documented environment behavior. A missing token or database prerequisite must produce a useful setup state rather than leaking credentials. Healthy saved configuration opens the normal console; incomplete/invalid setup opens the wizard. Rechecking permissions refreshes current roles/channels, not just startup cache.

Opus inspection was attempted before coding, but the local Claude CLI returned “Not logged in”. No successful Opus review is claimed. The primary reviewed the bounded lifecycle/configuration design and Luna independently checked its source compatibility.
