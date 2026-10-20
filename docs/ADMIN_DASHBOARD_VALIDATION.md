# Admin console validation (draft)

Draft by lane L8 (QA), 19 October 2026, for the read-only console (Wave 2). Tested on `admin/qa` after merging
`feat/admin-dashboard` at e919199 (it includes the Wave 2 review fixes).

Extended by lane L11 (QA), 19 October 2026, for the admin actions (Wave 3). Tested on `admin/qa` after merging
`feat/admin-dashboard` at 84464b4 (Wave 3 with both review-fix rounds). See "Wave 3: admin actions" below; the
Wave 2 sections are kept as they were, with stale rows marked.

## How the evidence was produced

- **End-to-end tests:** Playwright 1.64.1 drives the installed Chrome (`channel: 'chrome'`) with one worker. Specs
  are in `apps/web/e2e/`. Run them with `npm run test:e2e` from the repository root. The script builds
  everything first, then serves the prebuilt `dist`.
- **The shared demo:** `playwright.config.ts` starts `node ../server/dist/admin/demo.js` on a random port with a
  fixed launch token. Specs that change server state start a private demo process instead (rotate-link, rate
  limit, shutdown and live updates), so they never disturb the others.
- **Held scenarios:** the stock demo plays a 2¾-minute script on a loop, so a given state can be minutes away.
  `e2e/support/scenario-demo.mjs` replays the first *n* steps of the **real** `demoScript()`, 40 ms apart,
  through `runAdminDemo()`, and then holds that state. Everything else is production code: the real domain
  `transition()`, the HTTP layer and the stream. The live-updates spec uses the unmodified stock demo.
- **Unit tests** were written by the build lanes. L8 ran them once on the merged tree:
  - web (Vitest): 27 files, 270 tests, all passing;
  - server (`node:test`): 150 tests, 147 passing, 3 skipped (the PostgreSQL tests, which need
    `DATABASE_URL`).
- **Screenshots** go to `%TEMP%\l8-shots\` (outside the repository). Set `TCG_E2E_SHOTS_DIR` to change this.

**Results.** Two consecutive full runs of `npm run test:e2e` on the final tree gave the same result: 74 passed,
3 skipped, 0 failed. The 3 skipped were the deliberate `test.fixme` specs for the Wave 2 bugs listed below, all fixed since. Before the
merge, the suite had also passed twice on the earlier base.

Status words used below:
- **Passing:** covered by a spec that passes.
- **Unit only:** covered by unit tests, not end to end.
- **Fixme:** a spec shows a real bug.
- **Not covered:** with the reason.

## Experience requirements

### Shell and top bar

| Requirement | Evidence | Status |
| --- | --- | --- |
| Sidebar lists the active event first with a live indicator, retired events below as read-only history | `shell.spec.ts` › sidebar history (held scenario: one event played, retired, then a fresh one) | Passing |
| Selecting a retired event shows "History", the retired banner and a closed needs-you queue; "TCG Live" follows the live event again | `shell.spec.ts` › sidebar history; › an event that retires while the tab is open | Passing (the second was a bug before the review fixes; it is now a regression guard) |
| Sidebar collapses, and the choice persists | `shell.spec.ts` › sidebar collapse and theme persist | Passing |
| Connection status and the account at the bottom of the sidebar | `shell.spec.ts` › sidebar footer… | Passing |
| Breadcrumb `TCG Live › <event> › <stage>` | `shell.spec.ts` › breadcrumb, runtime chips…; `live.spec.ts` (the stage changes live) | Passing |
| Live preview and List preview toggles with `aria-pressed` | `shell.spec.ts` › clicking the toggles… | Passing |
| Alt+1 and Alt+2 toggle the panes; ignored while typing | `shell.spec.ts` › Alt+1 and Alt+2…; › shortcuts are ignored while typing | Passing |
| Discord and PostgreSQL status chips (both "Demo" in the demo) | `shell.spec.ts` › breadcrumb, runtime chips… | Passing (demo states only; other states are unit only, `shell.test.tsx`) |
| Theme and account menu: theme choice, rotate link, sign out | `shell.spec.ts`, `rotate.spec.ts`, `login.spec.ts`, `a11y.spec.ts` › account menu… | Passing |
| Closing a pane returns focus to its top-bar toggle | `shell.spec.ts` › clicking the toggles… | Passing |

### Main window

| Requirement | Evidence | Status |
| --- | --- | --- |
| Stage stepper (Signup → Check-in → Round 1 → Standings) with counts | `live.spec.ts`; `canvas.spec.ts` › event complete | Passing |
| Needs-you card per match with judge attention, with reasons and *Open in live preview* | `canvas.spec.ts` › "Open in live preview" on a needs-you card… | Passing |
| A running match that keeps judge attention reads "play resumed" | `canvas.spec.ts` › final match… (step 25: M1 resumed by the judge) | Passing |
| Activity stream, chat-style, newest at the bottom, live without a reload | `live.spec.ts` | Passing |
| Scroll pinning and *Jump to latest* ("New activity · Jump to latest" when scrolled up) | `live.spec.ts` (mouse-wheel scroll up, a new entry arrives, jump back) | Passing |
| Applied changes only | `live.spec.ts` and `lists.spec.ts` show the hint; the server stores only applied changes | Passing (presence of the wording only) |
| No command composer and no action controls before Wave 3 | Superseded in Wave 3: the demo console now shows them (`shell.spec.ts` › sidebar footer… the demo console can act); a commands-off console shows none (`shell.spec.ts` › a read-only console…) | Passing |

### Preview dock

| Requirement | Evidence | Status |
| --- | --- | --- |
| Zero, one or two panes; both stack with a resizable divider | `shell.spec.ts` › clicking the toggles…; › persistence… | Passing |
| Open panes, dock width, split ratio, list tab and canvas view persist in localStorage | `shell.spec.ts` › pane state, dock width, split ratio, list tab and canvas view survive a reload; › closed panes stay closed | Passing |
| Dock width by keyboard and pointer drag | `shell.spec.ts` › persistence… | Passing (bug 2 fixed; regression spec) |
| Below 1100 px the dock becomes an overlay sheet: modal, focus trap, Escape and backdrop close it | `a11y.spec.ts` › below 1100 px (3 specs) | Passing |
| Live preview: Event view and Match view | `canvas.spec.ts` | Passing |
| List preview: Players, Matches, Audit and Discord tabs | `lists.spec.ts` | Passing |

### Visual rules

| Requirement | Evidence | Status |
| --- | --- | --- |
| Light and dark themes | `screenshots.spec.ts` (18 screenshots) and `shell.spec.ts` (theme persists) | Passing. Reviewed by eye; see the visual notes below |
| Tabular numbers for clocks and counts | `canvas.spec.ts` › Event view… (`font-variant-numeric` on the match clock) | Passing (clock checked; counts by eye) |
| `prefers-reduced-motion`: static ring, no dash flow, no traveling dot | `a11y.spec.ts` › reduced motion | Passing |
| IME composition guard in the composer | `apps/web/src/ui/CommandComposer.test.tsx`, `features/commands/commands.test.tsx` | Unit only (Playwright cannot drive a real IME) |
| Scroll-pin cooldown | `apps/web/src/ui/hooks/hooks.test.tsx` | Unit only. The plan says a 150 ms cooldown; the code now uses a 250 ms user-intent window, so only wheel, touch, key or pointer input unpins. The plan wording needs updating |
| Spring motion presets, warm surfaces, hairlines, clay accent | Screenshots | Reviewed by eye |

### Canvas semantics

| Requirement | Evidence | Status |
| --- | --- | --- |
| Clay rotating ring on a live node; slow red ring on a node waiting for a judge | `canvas.spec.ts` › Event view… (ring classes; animation 2.2 s against 6 s) | Passing |
| Dotted edges flow into the current node: clay for live play, slow red for a judge wait, static green when done, grey when not reached | `canvas.spec.ts` › Event view… (edge classes; 0.9 s against 2.4 s; done edges not animated) | Passing |
| Traveling dot on active edges | `canvas.spec.ts`; absent under reduced motion (`a11y.spec.ts`) | Passing |
| Final match: static green, winner shown, untaken branches muted, no ring | `canvas.spec.ts` › final match…; › event complete | Passing |
| Match view lifecycle (ready, running, paused, proposal, confirm, dispute, judge, final) | `canvas.spec.ts` › the view switcher…; › final match… | Passing |
| Clicking a match node (or Enter on it) opens the Match view | `canvas.spec.ts` › the view switcher… | Passing |
| Clocks tick on the client; a paused clock is frozen | `canvas.spec.ts`, `live.spec.ts` | Passing |
| Interrupted clock shown frozen with an *interrupted* label, never a live ring | `layout.test.ts`, `LivePreview.test.tsx`, `mappers.test.ts`, `shell.test.tsx` | Unit only: the demo has a single runner, so it never produces an interrupted clock |
| Tall dock: top-to-bottom layout | Screenshots (live only, 1280 and 1440) | Reviewed by eye; reads well |
| The Event view fits its pane | `canvas.spec.ts` › Event view fits its pane | Live pane alone and after *Fit view*: passing. First automatic fit in a short pane: passing (bug 1 fixed; regression specs) |
| At most five graph updates per second | `throttle.test.ts` | Unit only |

## Wave 2 lane requirements

| Lane | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| L6 | Sidebar, top bar, breadcrumb, toggle tabs, rotate-link item | See the shell table | Passing |
| L6 | Preview dock: split, persistence, shortcuts, sheet below 1100 px, spring transitions | See the dock table | Passing (bugs 1 and 2 fixed; regression specs) |
| L6 | Main controls: stepper, needs-you cards with reasons, activity stream | See the main window table | Passing |
| L6 | Login screen | `login.spec.ts` (9 specs) | Passing |
| L6 | Connection banner | `shutdown.spec.ts`: after the server stops, the open tab shows the reconnecting or offline banner | Passing |
| L6 | Lease, database and interrupted-clock banners | `shell.test.tsx` | Unit only: the demo has no lease or database |
| L6 | Live preview hosting L5 with L4's server clock | `canvas.spec.ts`, `live.spec.ts` | Passing |
| L7 | Players, Matches, Audit, Discord tabs on the kit DataTable | `lists.spec.ts` | Passing |
| L7 | Names from the `members` directory | `lists.spec.ts` › Players (removed member absent); `canvas.spec.ts` (names on cards) | Passing |
| L7 | Audit filters, search, raw JSON disclosure | `lists.spec.ts` › Audit… (actor, match and command filters; search; empty state; Clear filters; Enter on a row opens the raw JSON; close) | Passing |
| L7 | Audit paging | `audit.test.tsx` | Unit only: the demo audit stays under one page |
| L7 | Tab keyboard: arrow keys, Home, End, wrap, a single tab stop | `lists.spec.ts` › tabs… | Passing |
| L7 | Enter on a match row opens it in the live preview | `canvas.spec.ts` › a match row…; `a11y.spec.ts` (sheet) | Passing |
| L8 | Login, rotate-link, toggles and persistence, live updates, canvas states, list tabs, keyboard paths, reduced motion, below 1100 px | All of the above | Passing |
| L8 | Light and dark screenshots at 1280 and 1440 px | `screenshots.spec.ts` | Passing; reviewed |
| Gate | Windows Ctrl+C with an open stream stops cleanly | `shutdown.spec.ts` | Passing; see "Windows shutdown" |

### Login and sessions in detail (`login.spec.ts`, `rotate.spec.ts`)

- `/#login=<token>` signs in and leaves `http://127.0.0.1:PORT/` with an empty fragment. Only the bearer
  token is stored, in `sessionStorage`; the launch token is not in the URL or in `localStorage`. A reload
  keeps the session.
- A bad token shows "Sign-in failed" with an actionable message.
- Without a session the login screen shows, with focus in the link field.
- A pasted link signs in. An empty field explains what to paste. A link for another console origin is refused
  with no request sent.
- A new tab needs the link. The first tab stays signed in.
- Sign out returns to the login screen, and the old bearer token gets 401.
- A revoked stored session explains "Your session ended".
- Opening the link again in a signed-in tab strips it, shows "Already signed in" and sends no sign-in request.
- Rotate link: account menu, then the confirm dialog (Cancel rotates nothing), then a toast. The demo prints the
  new link on stdout, and the spec reads it from there. The old link is refused, the new one works, and the
  current tab stays signed in.
- The rotate-link API needs a session (401) and an allowed Origin (403).

### Security smoke (`security.spec.ts`, raw `node:http`, so headers and paths go out exactly as written)

- **Host check:** a wrong Host gets 403 `bad_host` for the API and the app shell. This includes another port,
  a missing port and `[::1]`. Both `127.0.0.1:PORT` and `localhost:PORT` are accepted.
- **Origin check:** a non-GET request with a missing, foreign, `null`, other-port or `https` Origin gets 403
  `bad_origin`. A refused DELETE leaves the session intact.
- **No CORS:** no `Access-Control-*` headers, even for a foreign Origin or a preflight.
- **Bearer tokens:** the API without one is 401 with `WWW-Authenticate: Bearer`.
- **Health routes:** `/livez` returns 200 `{"status":"live"}`, even with a foreign Host. `/readyz` returns 503
  in the demo (no database). Near-misses (`/livez/`, `/LIVEZ`, `/%6civez`, `/readyz?x=1`) are 404 and never
  the app shell.
- **Traversal:** seven static traversal attempts (encoded `..`, backslashes, a drive path, a dotfile, NUL)
  all get 400.
- **Headers:** the exact CSP, `Referrer-Policy: no-referrer` and `nosniff`. `no-cache` on `index.html`,
  immutable caching on hashed assets, `no-store` on the API. The favicon is served as `image/svg+xml`.
- **Rate limit:** after 10 failed sign-ins in a minute, even the right token gets 429 with `Retry-After: 60`.
  Run on a private demo.
- **Logs:** the launch token appears on stdout only in the startup line, and never on stderr.

### Keyboard and focus (`a11y.spec.ts`)

- Tab from the sidebar reaches, in order: Live preview, List preview, the Discord chip, the PostgreSQL chip,
  and the account menu. It then reaches the dock: the resize handle, Close live preview, the canvas nodes,
  Event/M1/M2 and the zoom controls. Every stop matches `:focus-visible` and shows an indicator.
- The account menu opens with Enter; End moves to the last item; Escape closes the menu and returns focus to
  the trigger.
- The rotate dialog (`alertdialog`, `aria-modal`) keeps Tab and Shift+Tab inside, with visible focus. Escape
  or Cancel closes it and returns focus to the account button.
- **Sheet below 1100 px:**
  - 30 Tabs and 5 Shift+Tabs stay inside it.
  - Escape first closes a tooltip opened for the focused control, if there is one (the floating-layer rule),
    then the sheet. Focus goes back to the toggle.
  - A backdrop click and the close button also dismiss the sheet.

## Wave 3: admin actions

### How this was tested

- **The interactive demo.** `e2e/support/scenario-demo.mjs` now also starts the demo in interactive mode
  (`scenario: { mode: 'interactive' }`). The script's players act on their own, and the script pauses at each
  admin decision until the console's command lands. Specs read the pause state over an IPC channel
  (`demo.state()`: `pausedAt`, `step`, `playMode`, `cycles`), and can also call `resumeScript()` or close the
  runtime while HTTP stays up (for the 503). Other options: `finalHoldMs`, `endWaitMs`, `commands: 'off'` and
  `capabilities: [...]`.
- **No server code was changed.** The read-only fixture and the "capability missing" fixture use options that
  `runAdminDemo()` already takes: its `createHandler` hook builds the real HTTP layer with
  `commandsEnabled: false`, or with the layer's own capability test seam. The read-only fixture is the console
  that Discord mode serves without `TCG_ADMIN_COMMANDS=1`: the session reports `commandsEnabled: false` and holds
  only `dashboard.read`.
- `support/demo.ts` drops any inherited `TCG_ADMIN_DEMO_MODE`, and every scenario passes its mode explicitly.
  A caller shell with `TCG_ADMIN_DEMO_MODE=interactive` therefore cannot turn the held or stock specs
  interactive. `playwright.config.ts` is outside the QA lane; see the note under "Test infrastructure".
- **HTTP contract specs** use raw `node:http` (`support/commands.ts` `postCommand` and `postRefresh`). They
  sign in with `apiLogin` and read state back through the API.
- **Each UI action spec checks three things.** The stream's `change` updates the UI in the same document (a
  `window` marker survives, so nothing reloaded). The activity stream shows an "admin … via console" group, and
  the audit API shows `via: 'web'`, `principalId: 'local-admin'` and `commandId: web:<uuid>`. The interactive
  scenario then moves on to its next pause.

**Results on the final tree (84464b4 plus this lane's specs):**
- `npm run typecheck:all` and `npm run build:all`: clean.
- `npm run test:all`:
  - core 4/4;
  - server 204 tests, 200 passing and 4 skipped (the PostgreSQL tests);
  - web 31 files, 347 passing.
- **Full Playwright suite, two consecutive runs:** 112 tests each time, with 109 passed, 3 skipped and 0 failed
  (3.6 minutes each). The 3 skipped were the `test.fixme` specs for bugs 3 to 5 below. After the orchestrator
  fixed those bugs (dd09c7f), two further consecutive full runs passed 112 of 112 with no skips (3.8 minutes
  each), and the three specs are now regression guards. `npm run test:all` then gave web 348 passing. Spec counts: `a11y` 9,
  `canvas` 11, `commands` 13, `commands-api` 10, `composer` 6, `conflicts` 3, `lists` 5, `live` 1, `login` 9,
  `rotate` 2, `screenshots` 18, `security` 8, `shell` 13, `shutdown` 3, `smoke` 1.

### Commands through the UI (`commands.spec.ts`, `composer.spec.ts`, `conflicts.spec.ts`)

| Requirement | Evidence | Status |
| --- | --- | --- |
| Signup remove: the Players row action, a confirm dialog (Escape cancels and returns focus), the roster updated live, and the script resumes (Dee joins, then it waits for the close) | `commands.spec.ts` › …whole script… › signup remove | Passing |
| Panel refresh from the stepper: a toast, `panelRevision` +1 shown in the Discord tab, no audit entry, and the pause is not answered | › panel refresh | Passing |
| Signup close from the stepper: seats assigned, the stage moves to Check-in, the players check in, and the script waits for publication | › signup close | Passing |
| Publish from the composer, keyboard only (`/pub`, Enter accepts the suggestion, Enter runs it) | › publish | Passing |
| Judge-resume from the needs-you card: the reason is required, the counter shows, Ctrl+Enter confirms, and the clock runs again | › judge-resume | Passing |
| Resolve from the Matches row menu: the winner is required, and 501 characters are refused with the counter at 501 / 500 | › resolve: the Matches row menu… | Passing |
| Resolve from a complete composer line (`/resolve M1 @A <reason>`) runs at once, after M1's clock ran out (an expiry decision) | › resolve: a complete composer line… | Passing |
| Correct: a danger menu item and a danger alertdialog; the recorded winner cannot be chosen; the acknowledgement is required; afterwards the event retires and a fresh one starts and pauses | › correct… | Passing |
| History shows no stepper actions and no composer | › correct… (end) | Passing; the list tabs too since bug 3 was fixed |
| Signup reopen, and close again from the composer with the `/tcg-test` prefix; removal from the composer by mention (`/signup-remove @Eli_Moss`) always confirms | › signup close and reopen | Passing |
| Removing instead of closing: the script waits for the players (`waitingFor: 'players'`), Eli rejoins about 2 s later, then the close is the admin's again | › recovery and clocks… › removing instead of closing | Passing |
| A clock runs out while the script waits on another match: the timer entry reads "via timer" (audit `system`), and after the judge-resume the expired match is the next decision, then M1's | › recovery and clocks… › a running clock expires… | Passing |
| Composer suggestions: only commands runnable now; arrows wrap and set `aria-activedescendant`; Escape hides and typing reopens; matches, then winners by seat or name; usage hint | `composer.spec.ts` › suggestions | Passing |
| Composer parse errors shown inline in `role="alert"`, with `aria-invalid`, nothing sent (9 cases: wrong seat, unknown command, no slash, unavailable command, unknown match, unknown member, member in the other match, extra option, a bare `/tcg-test`) | › parse errors… | Passing |
| An incomplete resolve opens a prefilled dialog (winner checked, focus in the reason); Escape keeps the line; finishing the dialog clears the composer | › an incomplete resolve… | Passing |
| Named options and a member mention (`match:M2 winner:@Dee_Ross reason:…`) run directly | › named options… | Passing |
| A correction from the composer, keyboard only, always confirms in the danger dialog (Tab to the acknowledgement, Space, Tab to the button, Enter) | › keyboard only… | Passing |
| `/tcg-test refresh` | › /tcg-test prefix… | Passing |
| Two tabs: a resolution in one appears under the other tab's open dialog ("M2 changed since you opened this. Now:", "no longer available", the confirm disabled), and that tab sends nothing | `conflicts.spec.ts` › two tabs… | Passing |
| No stream (the stream route aborted for that tab), with an API command racing the dialog: exactly one POST, answered 409; the dialog explains the change; the Matches row shows the 409 snapshot's winner without a reload or a stream | › no stream… | Passing |
| A player step under an open dialog: "Review the change", Ctrl+Enter only reviews, then the resolve sends the fresh precondition (`proposalRevision: 2`) | › interactive: a player step… | Passing |
| No composer and no controls when `commandsEnabled` is false (signup state and live-round state; the needs-you card keeps only "Open in live preview"); the demo console does show them | `shell.spec.ts` › a read-only console… (2 specs); › sidebar footer… the demo console can act | Passing |
| The composer's focus ring sits on its frame (`:focus-within`) | `a11y.spec.ts` › Tab reaches the top bar… (the helper now accepts a 3 px ring on a focused frame) | Passing |
| Escape layer in dialogs, focus return to the opener | `commands.spec.ts` › signup remove; `composer.spec.ts` › an incomplete resolve… | Passing |

Not end to end:
- "Saved; Discord display pending" toasts, and room-warning toasts in the danger tone. The demo's cards always
  update and it has no match rooms, so the demo cannot produce them. They are unit only
  (`features/commands/model.test.ts`, `commands.test.tsx`, `discord-commands.test.ts`).
- The final hold's release after `finalHoldMs` without a correction (unit only, `demo-commands.test.ts`).
  End to end, the hold releases on a correction (› correct…).
- Automatic retries with the same commandId after a network error or a 503. Unit only (`client.test.ts`);
  end to end, the server side of a retry is covered below.

### Server contract over HTTP (`commands-api.spec.ts`)

Each error body is exactly `{ error: { code, message } }`, plus `snapshot` for 409, with `application/json` and
`Cache-Control: no-store`.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Session: all six capabilities and `commandsEnabled: true` in the demo; 401 without a bearer; 403 `bad_origin` for a foreign Origin; GET gets 405 with `Allow: POST` | › the session holds every capability… | Passing |
| 400 `bad_request` for 24 malformed bodies: empty, not JSON, an array, unknown keys, a missing precondition, a bad or v1 UUID, a bad event ID, a player command type, extra fields, a bad member ID, M3, seat E; reasons that are empty, blank, zero-width only, 501 characters after trimming, or not a string; publish without `eventVersion`; a negative version; the wrong match precondition; close without the signup; a bad signup status; unknown precondition keys. Also 2 bad refresh bodies. A 500-character reason after trimming passes validation. Nothing changes and the pause holds. | › 400: strict validation… | Passing |
| 404 `not_found` for an unknown event (commands and refresh) | › 404… | Passing |
| 422 `rule` with the rule text: publish while signup is open, a winner outside the match, judge-resume before publication; no audit row | › 404 …; 422… | Passing |
| 409 `conflict` with the latest snapshot for a stale precondition; a stale `eventVersion` beats the rule error that publish would otherwise get | › 409 + the latest snapshot… | Passing |
| 200 with `{ applied, result, version, cards, roomWarning }`. An identical retry after the state moved on returns the same body, as does a retry with an upper-case command ID and event ID. There is one audit row (`via: 'web'`, `local-admin`, `web:<uuid>`). | › 200, then an identical retry… | Passing |
| A reused command ID with other content (another member, another precondition, another event ID) gets 409 "already used" with the snapshot | › 200, then an identical retry… | Passing |
| A no-op is a 200 with `applied: false` (`No change: not_joined.`); panel refresh is a 200 `{ cards: 'refreshed', roomWarning: null }` that moves only `panelRevision` | › a no-op… | Passing |
| 503 `unavailable` once the runtime is closed while HTTP is up (commands and refresh) | › 503… | Passing |
| 409 "This event is no longer active." with the *active* event's snapshot (commands and refresh); a stored success for that retired event is still returned to its retry | › an event that is no longer active | Passing |
| Commands off: the session holds only `dashboard.read` and `commandsEnabled: false`; 403 with "Admin commands are disabled for this console (TCG_ADMIN_COMMANDS)." before validation (a valid and a nonsense body); refresh 403; nothing changes | › decision 4: commands off | Passing. Refresh answers "This session may not do that." instead (see the notes) |
| A capability missing (`dashboard.read` and `match.judge` only): `correct` and `publish` get 403 "This session may not do that."; refresh gets 403; validation still comes first (400); a granted `resolve` applies | › a capability missing | Passing |

### Bugs found in Wave 3 (all fixed in dd09c7f)

| # | Severity | Where | What happens | Repro | Spec |
| --- | --- | --- | --- | --- | --- |
| 3 (fixed) | Major | `apps/server/src/admin/runtime/mappers.ts:257` (a retired snapshot gets `panelRevision: 0`) with `apps/web/src/data/cache.ts:41` `isSnapshotNewer` and `features/shell/model.tsx:129` | A retired event's snapshot comes back with `panelRevision` 0 at the same version. The web keeps its cached copy, which still says `active`, whenever the event ever had a panel revision. Every demo event has one (the check-in card repost). In Discord mode, any card edit gives one. The shell then sees summary `retired` against snapshot `active` forever and refetches the snapshot in a tight loop: 451 GETs in 2 s on the final tree, and each would be a PostgreSQL query in Discord mode. The history event's list tabs also keep their row actions ("Actions for M1/M2", remove buttons), because they read `snapshot.status`. A click there sends a command that gets 409. | Held scenario `{ steps: 28, durationMs: 3000, retireOnce: true, retireGapMs: 4000 }`. Open the console with the List preview on Matches, and wait for the event to retire while watched. Select it under History. Count the `/snapshot` requests, and look at the Matches rows. | `commands.spec.ts` › regressions: retired history › a just-retired event… (fix: `isSnapshotNewer` prefers the retired copy at the same version) |
| 4 (fixed) | Moderate (keyboard/a11y) | `apps/web/src/features/commands/actions.tsx:63` `stopRow` on the wrappers of the Players remove buttons and the Matches "Actions for" menus | Every keydown is stopped from propagating, not only the row-activation keys. Below 1100 px, in the modal preview sheet, Tab from the last remove button leaves the sheet: focus goes to `<body>`, then to the sidebar behind the modal. Escape on a row action does not close the sheet. The Wave 2 trap spec failed on the shared demo because of this. | 1000×800, signup open with members (held scenario `{ steps: 4 }`). Open the sheet with the List preview on Players. Focus the last "Remove … from the signup", press Tab, then Escape. | `a11y.spec.ts` › below 1100 px › regressions › Tab and Escape on a row action… (fix: `stopRow` stops only click, Enter and Space). The general trap spec now runs on the commands-off fixture. |
| 5 (fixed) | Minor | `apps/web/src/features/console/ActivityStream.tsx` `groupActivity`/`actorKey` | Entries are grouped by actor only, and the header shows the first entry's `via`. A console action within 5 minutes of a Discord action by the same admin is shown "via Discord". The Audit tab is right per row. In Discord mode with `TCG_ADMIN_COMMANDS=1` this mislabels real web actions. | Autoplay held scenario `{ steps: 7 }` (the scripted admin closed signup via Discord). Click "Reopen signup". The new line joins the "Admin · via Discord" group. | `commands.spec.ts` › regressions: activity attribution (fix: groups split by `via` as well as actor) |

Notes, not filed as bugs:
- **Two 403 texts.** With commands off, `/panels/refresh` answers 403 "This session may not do that." and not
  the `TCG_ADMIN_COMMANDS` text: the router's capability gate runs before the route. The web shows the same
  message for every 403, so this is cosmetic.
- **Enter on an exact mention.** In the composer, Enter on a word that already equals the only suggestion
  accepts it (adding a space) rather than running the line. A trailing space, or a second Enter, runs it. This
  is ordinary combobox behaviour.
- **Fixed upstream before the final run:** a removal at the close pause used to skip the close and stall the
  event (now the "removing instead of closing" spec). The final hold had no bound (now `finalHoldMs`). Clocks
  did not run out while the script was paused (now the clock spec).

### Pending live checks (not provable offline)

- **A real Discord session with `TCG_ADMIN_CONSOLE=1` and `TCG_ADMIN_COMMANDS=1`.** For each command, check
  that the console action:
  - goes through the controller's tracking, accepting and lease gates;
  - edits the real cards;
  - arms the expiry timer after a judge-resume;
  - syncs the match room;
  - shows "saved; Discord display pending" when Discord is slow, and a room warning when a room cannot be
    updated;
  - leaves the same audit as the slash command, with `principal_kind = 'web'`.

  Also check that a slash command and a console action on the same match race into a 409, not a double apply.
  Finally, with `TCG_ADMIN_COMMANDS` unset, check that the live console shows no controls. This lane proved
  that only on the demo's commands-off fixture.
- **A real PostgreSQL run of the opt-in database tests.** `npm run test:db` with `DATABASE_URL` set covers
  `commands.db.test.ts`: the prior result returned under `FOR UPDATE`, preconditions checked after the lock,
  and the unique `(event_id, command_id)`. It also covers the Wave 2 `queries.db.test.ts`. Those are the 4
  skipped server tests.

## Bugs found in Wave 2

Both Wave 2 bugs were fixed upstream; their specs now pass as regression guards (`canvas.spec.ts` › …the first
automatic fit shows every node; `shell.spec.ts` › regressions › the dock resize handle…). The Wave 3 bugs are
listed under "Wave 3: admin actions".

| # | Severity | Where | What happens | Repro | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 (fixed) | Minor (visual) | Live canvas automatic fit: `apps/web/src/features/flow/index.tsx` and `viewport.ts` (Wave 2 review fixes) | In a short pane the first automatic fit leaves stage nodes outside the pane or under the view switcher and legend: Signup, Check-in and Round 1 at 1440×900 with both panes; Signup and Check-in in the 1000 px sheet. Pressing *Fit view* fixes it. | Demo at step 19 (or any state); viewport 1440×900; open both panes; look at the Event view. Or 1000×800, open the sheet. | `canvas.spec.ts` › Event view fits its pane › …the first automatic fit shows every node (2 fixmes) |
| 2 (fixed) | Minor | `.ui-split-handle` (`z-10`, `apps/web/src/ui/SplitPane.tsx:164`) against `.shell-dock-handle` (z-index 5, `apps/web/src/features/shell/shell.css:248-259`) | With both panes open, the live/list divider covers the dock resize handle where they cross, so a drag that starts there resizes the split instead of the dock. | 1440×900, both panes open; drag the dock's left edge at the height of the live/list divider. | `shell.spec.ts` › regressions › the dock resize handle can be grabbed… |

Another bug was found and then fixed upstream. Before the review fixes, a tab that watched an event retire kept
its cached snapshot as `active`, because the cache has `staleTime: Infinity` and the stream only pushes the new
event. Selecting the event under History then showed "Standings" instead of "History". The spec that showed it
now passes as a regression guard.

## Screenshots and visual notes

18 files in `%TEMP%\l8-shots\`, all reviewed by eye:
- `light|dark-1280|1440-{login,console-no-panes,live-only,both-panes}.png`;
- `light|dark-1000-sheet.png`.

The screenshot spec also asserts that the page never scrolls horizontally.

- **Clipped Event view.** In short panes (both panes open, and the 1000 px sheet) the first fit is clipped:
  bug 1. With the live pane alone, the new top-to-bottom layout is large and readable.
- **Matches table.** In a 480 px dock the last column ("Judge") is cut at the right edge; the table scrolls
  sideways with no visible cue.
- **Stepper.** At 1280 px with the dock open, the Round 1 detail truncates ("1 live · 1 jud…").
- **Chips.** At 1280 px the Discord and PostgreSQL chips drop their "Demo" detail, leaving a grey dot and the
  name. This looks intentional (container width), but the state is then only visible in the tooltip.
- **Activity feed.** The first visible activity group is partly hidden under the header fade. This is
  expected, because the feed is pinned to the bottom.
- **Themes.** Light and dark are otherwise consistent. Focus rings and the login card read well in both.

## Windows shutdown

`shutdown.spec.ts` (Windows only) starts the stock `demo.js` in a private, hidden console through
`e2e/support/console-ctrl.ps1`. It signs in a browser tab and opens a second, raw stream with a bearer token.
Then it sends that console a real `CTRL_C_EVENT`, and in a second test a `CTRL_BREAK_EVENT`.

**Result (the same in both full runs):**
- The process exits with **code 0**. The spec asserts under 5 s; the manual probe measured 6 ms (Ctrl+C) and
  5 ms (Ctrl+Break) from the event to the exit.
- It prints "Admin demo stopped." and nothing about the deadline on stderr.
- The raw stream client sees a clean **end** (not an abort).
- The open tab drops "Live updates" and shows the reconnecting or offline banner.

`demo.ts` registers the same `shutdown` for SIGINT, SIGTERM and SIGBREAK, with a 5 s watchdog that exits 1.
The handler is idempotent.

**What `process.kill(pid, 'SIGINT')` does.** On Windows, from a Node parent, it does **not** emulate Ctrl+C. It
is a TerminateProcess: exit code 1, no "stopped" line, and the stream is aborted. A third spec records this so
nobody mistakes it for a shutdown test.

**What was and was not verified.**
- **Verified:** real console control events against the demo process with open streams, including a browser
  stream.
- **Not verified:** a key press in an interactive terminal (Windows Terminal or conhost) with a person at the
  keyboard. The helper is the closest headless equivalent: same console event, same Node handler.
- **Not verified:** the Discord runtime's `shutdown()` path with the console on. It needs a live bot (see the
  boundary below).
- **Inherited ignore flag.** Processes started from this headless toolchain inherit "ignore Ctrl+C". The helper
  clears it before starting the demo, as a fresh terminal would. Without that step the event is silently
  ignored.

## Validation boundary (repeated from the plan)

**Offline proof:**
- unit tests (server `node:test`, web Vitest);
- end-to-end tests on the demo runtime;
- screenshots;
- the shutdown tests.

**Not covered offline:**
- **A live Discord session with the console enabled.** It needs the user's token and players. Nothing here
  exercises `DiscordAdminRuntime` against a real gateway, the lease, card refreshes or the identity cache.
  The Discord chip's states other than "Demo" are unit only.
- **PostgreSQL-backed tests.** This checkout has no local PostgreSQL, so `test:db` runs only when the user
  provides `DATABASE_URL`. The 3 skipped server tests are these. The database banner, the waiting state and
  retired-event reads from the store are unit only.

Provisioning PostgreSQL is not part of the plan.

## Other things not covered, and why

- **Interrupted clocks, lease loss, database outage, cards pending.** The demo cannot produce them. They are
  unit only (see the tables).
- **Audit paging past 500 entries.** The demo never writes that many. Unit only.
- **Idle and absolute session expiry (2 h and 12 h).** Too long for E2E. Covered by
  `apps/server/src/admin/http/session.test.ts` with an injected clock.
- **Stream resume after a reconnect (`Last-Event-ID`), the 45 s watchdog, and a build-change reload.** Covered
  by `apps/web/src/data/stream.test.ts` and `apps/server/src/admin/http/stream.test.ts`. E2E sees only one
  uninterrupted stream (`live.spec.ts` asserts exactly one stream request).
- **Screen-reader output.** Not checked; only roles, names, `aria-*` and focus are asserted.
- **Browsers other than the installed Chrome.**

## Test infrastructure notes

- `playwright.config.ts` is unchanged. Its `webServer` (the shared stock demo) inherits the caller's
  environment. A shell with `TCG_ADMIN_DEMO_MODE=interactive` would make the shared demo interactive, and the
  specs that expect it to advance on its own (`live.spec.ts`) would time out. Unset it before running E2E, or add
  `TCG_ADMIN_DEMO_MODE: 'autoplay'` to `webServer.env`. The file is outside the QA lane.
- Wave 3 helpers: `e2e/support/commands.ts` (raw command requests, preconditions, pause waits, console
  locators) and the scenario options in `e2e/support/demo.ts`. A held autoplay scenario keeps playing for about
  `steps × 40 ms` after the console link is printed, so specs that need it settled wait with `waitForHold()`.
- On Windows, a Node `fetch` keep-alive socket to a demo that a spec has killed makes the Playwright worker hit
  a libuv assertion at exit (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c:94`). It is harmless to
  results but noisy. The specs therefore use `e2e/support/http.ts` (`node:http` without keep-alive) for all
  direct API calls.
