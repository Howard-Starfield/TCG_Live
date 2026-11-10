# Windows one-click setup and database recovery

Verified 9 November 2026 (America/Los_Angeles).

## Cause and implementation

The existing portable PostgreSQL 18.6 cluster was stopped after an interrupted Windows session. The old batch launcher only reported reachability and schema failures; it never started the database.

Start TCG Live.bat now finds a usable Node/npm without requiring PowerShell on an already configured PC. If absent, a PowerShell bootstrap installs a checksum-pinned private Node distribution. This uses a per-checkout mutex and publishes only a validated extracted runtime. Existing explicit runtime overrides are validated rather than silently replaced. No global PATH or Node installer is needed.

After acquiring the existing launcher ownership lock, startup installs locked npm dependencies when needed, prepares the app-local PostgreSQL runtime/cluster, builds the app and applies schema 001, 002 and directory 003/004 only for the managed database. A local settings file is exclusively copied from the blank example only if missing. Existing settings are preserved.

The database is managed only when DATABASE_URL is unset or exactly matches saved local managed/legacy credentials for this checkout. An unrelated explicit URL is left untouched. Generated credentials are atomically persisted before initdb. Existing or partial nonempty data is never reset. Reuse authenticates the cluster, checks its data directory, version and loopback binding. New application roles are not superusers. The local database intentionally remains available after dashboard shutdown or a later build failure; it is verified/reused on the next launch, without a Windows service.

Downloads use pinned official HTTPS artifacts and SHA-256 checks. PostgreSQL archive size/entry paths are validated before extraction and publication. Only the Windows missing-DLL exit code can trigger the pinned Microsoft Visual C++ prerequisite installer. The helper verifies its Microsoft Authenticode signer and requests normal Windows UAC approval. Canceled approval and reboot requirements are surfaced; UAC is not bypassed. The Microsoft installer was not executed in this verification because the runtime already works here.

## Native evidence

- Stopped and restarted the real owned cluster; all 41 event aggregates and 408 audit rows match the prior baseline. Active event version remains 8; roster and all canonical Discord IDs remain unchanged.
- Executed the real batch launcher with PostgreSQL stopped. It started the database, checked schemas and launched the existing Discord session. Dashboard authenticated successfully; status reports database ready and gateway ready. Screenshot: output/playwright/oneclick-recovery-dashboard.png (ignored local evidence).
- A second batch launch reused the existing bot without a second build/process. Normal launcher browser behavior retains the existing authenticated rendezvous and dedupe mechanism.
- In an isolated checkout-shaped fixture, verified and extracted the official PostgreSQL archive, initialized a new SCRAM cluster, created a non-superuser app role/database, applied all schemas and reused it on a second call. No fake tournament/player rows were added. The fixture server was stopped afterward.
- In a separate isolated fixture, sanitized child PATH/USERPROFILE and removed runtime overrides. The bootstrap downloaded/verified private Node 24.22.2 and validated its bundled npm 11.19.1. The test used working bundled pwsh rather than Windows PowerShell 5.1.
- Native testing caught two Windows startup concerns: keep the PostgreSQL stdout log outside PGDATA so crash recovery does not scan an open output file; wait on the helper exit rather than inherited server pipe handles. Both are implemented and covered.
- 34 launcher/runtime tests passed, covering ownership/dedupe, external DB preservation, interrupted setup, wrong occupied server, unsafe archive/checksum rejection, fresh initialization, safe failures, helper process exit, and conditional Microsoft prerequisite behavior. The normal server/web build passed through the real launcher.
- Real Discord signup REST verification still finds the saved tournament title/game/description, Pokemon GIF and Join/Withdraw/View roster controls on the same message, with no mentions.

## Release checks still needed

- A pristine x64 Windows 10/11 VM with Windows PowerShell 5.1, no Node/npm/PostgreSQL, no Microsoft VC runtime, and a non-admin organizer account. Verify first launch, UAC allow/deny, required reboot and a full subsequent launch. These paths have source/unit and isolated native coverage, not clean-OS end-to-end proof.
- Offline/proxy-restricted first install, low disk space, antivirus interference and read-only application folders. Failure paths preserve data and report guidance; these environmental cases have not all been reproduced natively.
- Verify Ctrl+C, Windows sign-out/reboot, then repeat the batch startup. App-local PostgreSQL is intentionally persistent between ordinary app runs.
- A signed Setup.exe and desktop shortcut distribution remain a separate packaging step. Current delivery is one-click source-folder setup and launch, with the bot token/invite still supplied by the organizer.

Official distribution references: [PostgreSQL Windows binaries](https://www.postgresql.org/download/windows/), [EDB archive page](https://www.enterprisedb.com/download-postgresql-binaries), [pg_ctl](https://www.postgresql.org/docs/18/app-pg-ctl.html), and [Microsoft runtime guidance](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170). The pinned EDB checksum was computed from the downloaded official HTTPS archive; it is not represented as a vendor-published signature.
