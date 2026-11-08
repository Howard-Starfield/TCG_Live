# Persistent local dashboard and Windows launcher

## Scope

The organizer double-clicks `Start TCG Live.bat`. It selects a supported Node/npm, reuses this project's running instance or builds and starts one instance, then opens an authenticated dashboard in the default browser. No manual launch-token entry, routine dashboard session expiry, duplicate bot or duplicate browser tab. No Windows service or database installer.

## Design

Guided startup alone enables persistent local admin sessions. Existing direct/demo commands retain their timed defaults. Logout, link rotation, bounded session count, bearer authentication, Host/Origin checks and loopback binding remain in effect. Persistent-session expiry metadata must explicitly describe no deadline, rather than encode infinity in JSON.

A small Node launcher claims an ignored instance file atomically before building. It records the exact real project directory, PID, port and random per-instance authentication key. A second launcher validates the file and challenges the existing server using that key; it never trusts a generic health response or treats an arbitrary busy port as TCG Live. A live owner still building is waited for within a bounded budget. Reclaim only a proven dead owner's record; never kill another PID. Clean stop removes only the record owned by that instance. Consider PID reuse and concurrent stale-file reclamation in tests.

The existing loopback HTTP handler gains a keyed launcher action mounted only for guided startup, with the same Host/Origin restrictions. Its response confirms the instance identity and provides a private launch link only when a dashboard needs opening. Existing authenticated SSE connections identify an open dashboard, including setup. A short atomic open claim suppresses concurrent launches before the browser's SSE has connected. A closed browser can reopen after that bounded cooldown. No query-string credential, public login endpoint or browser automation framework.

The root batch file changes to its own directory, selects a compatible runtime and invokes the launcher. Dependencies must already be installed; show useful prerequisite errors. The bot's existing database prerequisite handling remains in onboarding. A supported bundled runtime may be discovered locally, but tracked scripts must not hardcode the developer's personal home path. Do not rebuild while an owned running instance is active.

Alternatives considered: PID-only reuse cannot authenticate the process occupying a port; a named-pipe application manager adds a second IPC framework. A protected rendezvous record plus an authenticated action on the existing HTTP server keeps this bounded.

## Verification

Exercise permanent sessions beyond old idle/absolute deadlines, logout and eviction, unchanged timed mode, wrong launcher key/Host/Origin, concurrent first/repeat launch, in-progress build, existing/open dashboard, closed dashboard/cooldown, dead/stale record, PID reuse, unknown occupied port, missing/unsupported runtimes, build failure and normal shutdown. Use synthetic processes for failure cases; preserve the real event and audit data when verifying the Windows launcher. Record actual browser/Windows proof separately from injected opener tests.

## Inspection

The requested Claude Opus 5.5 high-effort inspection was attempted again before coding. The local Claude CLI returned Not logged in, so no completed Opus review is claimed. Primary inspection approved the bounded plan; Luna will independently inspect the implemented ownership and lifecycle paths.
