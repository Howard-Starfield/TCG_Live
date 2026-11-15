# Next wave: shared brief for the parallel agents (2026-11-15)

Branch: `feat/next-wave`. Do not commit, do not run `npm install`. Six agents work at the same time, each owning its own files.

## Shared rules
- **Shared files:** re-read them right before editing, and make small, additive edits. These are:
  - `packages/core/src/*-contract.ts` (add optional fields or new types only; never rename or remove)
  - `apps/server/src/permissions/table.ts` (add your feature's entry)
  - the route, feature and web registries
  - `discord/interactions.ts` prefixes
  - `discord/admin-command.ts`
  - `apps/server/package.json` test globs
  - `README.md` (add your own section only)
- **Testing:** run `npm run typecheck:all` and `npm run test:all` from the repo root. Ignore failures that are clearly in another agent's in-progress files, and name them in your report.
  - The server `dist` is rebuilt by tests, so a run can collide with another agent's run. On "module not found" in dist, rerun once.
- **Tokens and secrets** must never appear in logs, API responses, the database or audit payloads.
- **Every mutation** is capability-checked and writes an audit entry. The demo (`npm run admin:demo`) must keep working, with in-memory fakes.
- **Report** in under 450 words: what you built, the files, decisions you made, and anything that needs a live Discord test.

## User decisions for this wave
- **Helper bots:** build phases H1 and H2 of `docs/HELPER_BOTS_PLAN.md` with all six recommended defaults (H3, nicknames, is included as part of the defaults).
- **Dashboard access:**
  - Add an "Allow dashboard actions" switch, saved in the local setup profile and on by default. It grants the capabilities that `TCG_ADMIN_COMMANDS=1` grants today.
  - When the switch is off, show a banner explaining it.
  - The `.env` flag still works for manual runs.
- **Tournament staff roles:**
  - The admin picks staff roles. Members with those roles can run the staff commands in `/tcg-test` and `/tcg-admin`.
  - Actions record who actually did them.
- **LFG:**
  - The admin chooses one or more LFG channels. There is no cap on posts or players.
  - A sticky "Looking for a game" button opens a form with game, format, note and an optional voice room. Submitting it posts a card with Join and Leave buttons and the list of who joined.
  - An optional LFG role is pinged, with a cooldown, and the card auto-closes after a set time.
  - Admins can customise every message: panel text, button label and emoji, card template, closed text, and ping text.
