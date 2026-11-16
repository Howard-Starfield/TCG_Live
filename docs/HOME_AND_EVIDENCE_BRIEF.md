# Brief: Home stats, interactive kanban, evidence pop-up with reply and text evidence

Branch: `feat/creation-dialogs` (the creation-dialog work is already in the tree, uncommitted). Two agents work in parallel with **disjoint file ownership**. Never edit a file owned by the other agent. If you need something from the other side, use only the interface written here.

Reference pattern: ESG repo, cloned read-only at `C:\Users\bobo\AppData\Local\Temp\esg-ref\repo\site\src\dashboard\`. Read it, never run it, and copy no code verbatim (some files are "Adapted from Infield Site v108", so the licence is unclear). The files that matter:
- `TaskPopup.tsx` and `task-popup-layout.css`: a right drawer, 620px wide, with an expand toggle to a centred panel (980px, `calc(100dvh-48px)`, 12px radius), full screen at ≤600px, and a 44px header with the title and X.
- `TaskRecord.tsx`: the two-column record, with content on the left and a 296px right rail of actions.
- `TaskCardToolbar.tsx` and `WorkspaceTaskActions.tsx`: quick actions on the card, and a right-click / Shift+F10 menu.
- `Dashboard.tsx` lines 370–388: a hash deep link for the open record, and closing restores the previous hash.

Product decisions (the user can still override them):
- **Stat pill:** shows the age of the oldest waiting item (for example "oldest 4m"). It turns warning-coloured after 5 min and danger after 10 min. It is hidden when the count is 0.
- **Evidence reply:** posts to the match's players in Discord by default. A "Staff note only" toggle keeps the reply in the dashboard instead.
- **Text-only evidence:** a full evidence item of a new kind `note` (typed text, no file and no link). It appears wherever evidence does.
- **No drag and drop on the kanban:** lanes are derived from match state. Actions move cards instead.

---

## Agent A: Home (web only), the Sonnet instance that built the creation dialogs

**Owns:** `apps/web/src/features/shell/Home.tsx`, `home.css`, `PlayerChart.tsx`, the new `apps/web/src/features/shell/MatchDrawer.tsx` (plus any `shell/match-drawer*.{tsx,css}`) and `shell/shell.test.tsx`, plus a new `shell/StatCard.tsx`.

### A1. Stats banner ("Action needed" counts)
Replace `.home-action-grid` with a row of stat cards modelled on the user's screenshot:
- **Card content:**
  - Label at the top left (13px, muted).
  - A rounded-square **icon chip** at the top right, about 32px, with the lane's lucide icon on a soft tinted background from the lane tone.
  - The **big number** at the bottom left (about 28px, semibold, tabular-nums).
  - The **pill** at the bottom right (see Product decisions). For In progress and Done there is no age pill. Show a neutral pill instead, such as "of N" or the round label, or none if nothing fits cleanly.
- **Lanes:** show all lanes as cards (Judge needed, Decision needed, In progress, Done), not just the first two.
- **Card style:** 1px `--color-line` border, about 12px radius, 16px padding. On hover, the card raises slightly (a shadow, as in the ESG card).
- **Clicking a card** scrolls to that lane on the board and focuses its first card.
- **Grid:** 4 columns with a 12px gap, 2 columns below about 44rem, 1 column below about 28rem.
- **Tokens:** use the existing tokens from `ui/ui.css`. No new hex colours.

### A2. Interactive kanban: match drawer
Today, clicking a card navigates away (`openActive(); shell.openMatch(id)`). Instead it should open `MatchDrawer`, a pop-up that follows the ESG drawer pattern.

**Building it:**
- Build it on `ui/Dialog` with `layout="drawer"`.
- Add an expand toggle that switches to a centred `xl` panel. If `Dialog` can't do both cleanly, add a minimal prop to `Dialog`. That is the only `ui/` change allowed, and it needs a test.

**Header:** "Match M1 · Ava Chen vs Ben Ortiz", the status badge, and the expand and close buttons.

**Left column:**
- Seats, with the score or result state.
- The clock (reuse whatever the console uses).
- The judge request details: reason, who called, when (`match.judge`, `requests`). Reuse `NeedsYou`'s formatting helpers where you can; import them, don't copy them.
- **Evidence**, embedded: render Agent B's exported `<MatchEvidencePanel eventId matchId />` from `features/evidence`. Until B lands it, import whatever `features/evidence/index.ts` exports today (`EvidenceButton`). B keeps that export working.

**Right rail:**
- The match actions, reusing `MatchActions` from `features/commands`: Resolve, Correct and Judge resume, with their existing confirm and reason flows and capability gates.
- `ModerateMembersMenu` for the seated players.
- A "Open in tournament view" link that does the old navigation.

**Card behaviour:**
- **Quick actions on the card:** an overflow `Menu` (also on right-click and Shift+F10) with Open, the match actions that apply, Copy match ID and Open in tournament view. Clicks on controls must not open the drawer.
- **Deep link:** the open match is in the hash (follow the existing hash router in `features/shell/model.tsx`; don't invent a second router). Closing restores the previous hash. Esc closes the drawer, and focus returns to the card.
- **Live updates:** the drawer reads from the live snapshot. If the match changes lane while it's open, the drawer stays open and updates.

### A3. Live card: actually compact
The last pass made the gap from the heading to the ring 16px, which kept the height at about 351px. The user wants it **shorter**:
- Keep the ring-to-chart gap exactly as it is now.
- Put the ring **on the same row as the heading**, top right, with the "4 of 4 assigned" stat under the heading on the left. This removes the separate stat row.
- Keep the gutters consistent with the ring-to-chart gap (`--home-gutter`).
- Target about 280px or less at 1000px wide, with the font and chart sizes unchanged.
- Measure the height before and after, and report both.

### A tests
- `shell.test.tsx`: stat cards render the counts and the oldest-age pill, and the warning tone appears after 5 min (use fake timers / server clock).
- Clicking a card opens the drawer and does not navigate.
- An action in the drawer calls the existing command path.
- The deep link opens the drawer.
- Esc closes the drawer and returns focus to the card.
- The overflow menu on the card works.

---

## Agent B: Evidence end to end (core + DB + server + web evidence)

**Owns:**
- `packages/core/src/evidence-contract.ts`
- the new `database/migrations/015_evidence_notes_and_replies.sql`
- `apps/server/src/evidence/**`
- the evidence routes, if they are registered outside that folder (keep that edit minimal)
- `apps/web/src/features/evidence/**`
- `apps/server/src/permissions/table.ts`, only if a new Discord permission is needed

### B1. Text-only evidence (kind `note`)
- **Contract:** add `'note'` to `EVIDENCE_KINDS`, plus a `CreateNoteEvidenceRequestDto { text: string }`. Pick a text max: 4000 is reasonable; justify it if you choose something else. The note's text lives in a field the UI can render. Either reuse `note` with a larger limit for kind `note`, or add a `text` column; pick one and explain it.
- **Migration 015:** relax and extend the CHECK constraints in `012_evidence_and_moderation.sql` lines 29–30 so that a `note` has no storage path, no URL and non-empty text. Write it the way earlier migrations are written (idempotent, and run by `node dist/evidence/cli.js setup`).
- **Server:** in `POST /api/v1/events/:id/matches/:m/evidence`, add a JSON body `{ kind: 'note', text }` alongside the existing link JSON (`{ url }`). Use the same auth, capability, audit and quota rules as links.
  - A note works with hold, soft delete, retention and the case `evidence_ids` like any other item.
  - There is no playback ticket, and asking for one returns a clear 400.
  - Exports include the text.
- **Web:** in the evidence drawer's add form, add a third mode, "Text", next to File and Link. "Save without attachment" must work: typing only text saves a `note`.
  - List items of kind `note` show the text (clamped, expandable), with no player.

### B2. Evidence pop-up with a reply thread
The evidence UI is already a `Dialog` drawer (`EvidenceDrawer.tsx`). Make it the place where the admin answers:
- **Thread per match:** add `tcg_evidence_replies` in migration 015 (id, event_id, match_id, author 'local-admin' or a Snowflake, body, `audience 'players'|'staff'`, discord_message_id null, status, created_at_ms). Add `GET/POST /api/v1/events/:id/matches/:m/evidence/replies`.
- **Composer:** at the bottom of the drawer, a textarea, a "Staff note only" switch (off by default) and a Send button.
  - Enter adds a newline. Ctrl/Cmd+Enter sends. Guard against double-submit with a ref, as in `CreateChannelInline`.
  - The thread shows replies interleaved with evidence items in time order, or as a separate "Replies" section if that's clearly simpler. Explain your choice.
- **Discord delivery** for `audience: 'players'`:
  - Post through the bot to wherever this match already talks to its players. Find the existing path in `apps/server/src/discord/controller.ts` (match room text channel or thread, or the card channel); don't invent a new channel.
  - Mention only the match's seated players. Use `allowedMentions` limited to those users, and never @everyone or roles.
  - Record the delivery status and the message id. A failed post keeps the reply, marked "Not delivered", with Retry.
  - Respect the session capability that already gates match actions (`match.judge`), and the "Allow dashboard actions" switch (read-only sessions can't send).
  - Audit as `evidence.reply`.
- **Demo:** the in-memory demo (`npm run admin:demo`) must support notes and replies. Fake the Discord delivery as delivered.
- **Export for Agent A:** `export function MatchEvidencePanel({ eventId, matchId }: { eventId: string; matchId: MatchId })` from `features/evidence/index.ts`. It's the drawer body (list, add form and reply thread) without its own Dialog, so A can embed it in the match drawer. `EvidenceDrawer` becomes a thin Dialog around it. Keep `EvidenceButton` working.

### B tests
- **Server:**
  - Note create, validation, hold, delete, and the playback-ticket refusal.
  - A reply with `staff` audience doesn't post to Discord.
  - A reply with `players` audience posts with mentions limited to the seats.
  - A delivery failure leaves the reply marked not delivered, and Retry works.
  - Capability and read-only checks.
  - The audit row.
- **DB:** add to the opt-in `*.db.test.ts` for migration 015's constraints. The orchestrator runs these against a throwaway cluster. **Never run `npm run test:db` yourself.**
- **Web:** Text mode saves without a file. The reply composer sends once on double Ctrl+Enter. The staff toggle is shown and labelled. A "Not delivered" reply shows Retry.

---

## Rules for both agents
- Match the existing style: Tailwind and `ui/` tokens, lucide icons, `ui` primitives, comments only where intent isn't obvious, each file's own line endings.
- Accessibility: dialogs have titles, focus returns to the opener, every control has a name, and the pill colour is never the only signal (the text says "oldest 12m").
- Must pass from the repo root: `npm run typecheck:all` and `npm run test:all`. Don't skip or delete tests.
- **Don't commit.** If you're stopped and resumed, run `git diff` first and continue from there.
- **Report back:** files changed, decisions you made (and why), anything you couldn't keep, and test counts.

---

## Added later: right pane and the judge "Close issue" (Agents A and C)

### Agent C: the `judgeClose` command (server, core and the web command layer)
**Owns:**
- `packages/core/src/admin-contract.ts`
- `apps/server/src/rehearsal/{domain,store}.ts` and their tests
- `apps/server/src/admin/{commands.ts,runtime/*}`
- `apps/server/src/discord/{controller,features}.ts`, judge-related parts only
- `apps/server/src/voice/feature.ts`, judge-related parts only
- `apps/web/src/features/commands/*`

Agent B may also edit `discord/controller.ts` for evidence-reply delivery. Make small, targeted edits there and re-read the file right before each edit.

**The command:** `{ type: 'judgeClose'; matchId: MatchId; reason: string }`, needing capability `match.judge`, the same as `judgeResume`.
- **Allowed when** `judgeAttention` is true and the match isn't `final`. It's refused when the proposal is `disputed`, because a dispute needs a result (Resolve). The refusal message says so.
- **Effect:** if the match is `paused`, restart the clock (as `judgeResume` does). Set `judgeAttention = false`. Record the reason (the admin's note) in the event store and audit like the other admin commands.
- **Discord:** the judge card or notice updates the way it does after resolve or resume. The match card shows the issue closed, without any player pings. Anything `voice/feature.ts` does on `judgeResume` (for example ending an on-judge-call recording) must also happen on `judgeClose`.
- **Demo:** the demo runtime supports it.
- **Web commands:** add it to `features/commands` (the match action list, its label "Close issue", its icon, and its availability when judge attention is set and the proposal isn't disputed) so the console's NeedsYou and the Home drawer can both use it. Export the availability helper. Agent A calls it through the existing command path.
- **Tests:**
  - Domain: allowed and refused cases, resume when paused, attention cleared, reason required.
  - Store: replay and audit.
  - Controller: the card updates.
  - Web: the action shows only when it's available.

### Agent A: right pane and judge card
- **Right pane:** follow the ESG `TaskRecord.tsx` layout and `task-popup-layout.css` closely, in your own code:
  - The drawer always has two parts: the main content on the left and a **right rail** of property sections on the right (about 296px when expanded).
  - The rail holds:
    - **Status** (lane, phase, clock)
    - **Players** (seats, with Moderate)
    - **Judge request**
    - **Actions**
    - **Links** (Open in tournament view, Copy match ID)
  - At the narrow drawer width (620px), the rail stacks **under** a compact header strip, not above the content. Status and the main actions stay visible without scrolling.
  - Section headings are small and uppercase, with a muted colour and thin separators, like the ESG rail.
- **Judge request card** (in the drawer, and the same component on the kanban card's quick view if that's cheap):
  - It shows the reason, who called and when, and the players' messages.
  - It has a **notes textarea**, required to close. When opened from the "Judge needed" lane, the textarea gets initial focus.
  - A primary **"Close issue"** button sends `judgeClose` with the note as the reason. It's only enabled when the action is available and a note is entered. When the proposal is disputed, show "This is a dispute: choose a winner with Resolve" instead, and point to Resolve.
  - Resolve, Resume and Correct stay as secondary actions.
  - After closing: a toast, the card leaves the Judge needed lane, and the drawer stays open and shows the updated state.
  - Guard against double-submit with a ref, and show the server's error inline.
  - Ctrl/Cmd+Enter in the notes field closes the issue.
- Until Agent C's `judgeClose` lands, build against the planned command shape. Typecheck will pass once C exports it.
