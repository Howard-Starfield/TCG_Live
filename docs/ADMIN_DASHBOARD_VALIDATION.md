# Admin console validation (draft)

Draft by lane L8 (QA), 19 October 2026, for the read-only console (Wave 2). Tested on `admin/qa` after merging
`feat/admin-dashboard` at e919199 (it includes the Wave 2 review fixes). Wave 3 (admin actions) is not covered
here; L11 extends this document.

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
3 skipped, 0 failed. The 3 skipped are the deliberate `test.fixme` specs for the bugs listed below. Before the
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
| No command composer and no action controls before Wave 3 | `shell.spec.ts` › sidebar footer…; no composer… | Passing |

### Preview dock

| Requirement | Evidence | Status |
| --- | --- | --- |
| Zero, one or two panes; both stack with a resizable divider | `shell.spec.ts` › clicking the toggles…; › persistence… | Passing |
| Open panes, dock width, split ratio, list tab and canvas view persist in localStorage | `shell.spec.ts` › pane state, dock width, split ratio, list tab and canvas view survive a reload; › closed panes stay closed | Passing |
| Dock width by keyboard and pointer drag | `shell.spec.ts` › persistence… | Passing. Fixme for one spot where the handle cannot be grabbed (bug 2) |
| Below 1100 px the dock becomes an overlay sheet: modal, focus trap, Escape and backdrop close it | `a11y.spec.ts` › below 1100 px (3 specs) | Passing |
| Live preview: Event view and Match view | `canvas.spec.ts` | Passing |
| List preview: Players, Matches, Audit and Discord tabs | `lists.spec.ts` | Passing |

### Visual rules

| Requirement | Evidence | Status |
| --- | --- | --- |
| Light and dark themes | `screenshots.spec.ts` (18 screenshots) and `shell.spec.ts` (theme persists) | Passing. Reviewed by eye; see the visual notes below |
| Tabular numbers for clocks and counts | `canvas.spec.ts` › Event view… (`font-variant-numeric` on the match clock) | Passing (clock checked; counts by eye) |
| `prefers-reduced-motion`: static ring, no dash flow, no traveling dot | `a11y.spec.ts` › reduced motion | Passing |
| IME composition guard in the composer | `apps/web/src/ui/CommandComposer.test.tsx` | Unit only (the composer ships in Wave 3) |
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
| The Event view fits its pane | `canvas.spec.ts` › Event view fits its pane | Live pane alone and after *Fit view*: passing. First automatic fit in a short pane: **fixme (bug 1)** |
| At most five graph updates per second | `throttle.test.ts` | Unit only |

## Wave 2 lane requirements

| Lane | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| L6 | Sidebar, top bar, breadcrumb, toggle tabs, rotate-link item | See the shell table | Passing |
| L6 | Preview dock: split, persistence, shortcuts, sheet below 1100 px, spring transitions | See the dock table | Passing (two fixmes, bugs 1 and 2) |
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

## Bugs found (open)

| # | Severity | Where | What happens | Repro | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | Minor (visual) | Live canvas automatic fit: `apps/web/src/features/flow/index.tsx` and `viewport.ts` (Wave 2 review fixes) | In a short pane the first automatic fit leaves stage nodes outside the pane or under the view switcher and legend: Signup, Check-in and Round 1 at 1440×900 with both panes; Signup and Check-in in the 1000 px sheet. Pressing *Fit view* fixes it. | Demo at step 19 (or any state); viewport 1440×900; open both panes; look at the Event view. Or 1000×800, open the sheet. | `canvas.spec.ts` › Event view fits its pane › …the first automatic fit shows every node (2 fixmes) |
| 2 | Minor | `.ui-split-handle` (`z-10`, `apps/web/src/ui/SplitPane.tsx:164`) against `.shell-dock-handle` (z-index 5, `apps/web/src/features/shell/shell.css:248-259`) | With both panes open, the live/list divider covers the dock resize handle where they cross, so a drag that starts there resizes the split instead of the dock. | 1440×900, both panes open; drag the dock's left edge at the height of the live/list divider. | `shell.spec.ts` › known issues › the dock resize handle can be grabbed… (fixme) |

A third bug was found and then fixed upstream. Before the review fixes, a tab that watched an event retire kept
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

- `playwright.config.ts` is unchanged.
- On Windows, a Node `fetch` keep-alive socket to a demo that a spec has killed makes the Playwright worker hit
  a libuv assertion at exit (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c:94`). It is harmless to
  results but noisy. The specs therefore use `e2e/support/http.ts` (`node:http` without keep-alive) for all
  direct API calls.
