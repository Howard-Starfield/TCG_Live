# Private Discord integration validation

The adapter is implemented on `codex/tcg-boilerplate`. Claude Opus 5.5 inspected the plan before implementation; GPT-6 Sol medium implemented it, Luna explored the existing owners and test coverage, and the primary agent reviewed the changes and ran the native database and live Discord checks. The user explicitly authorized use of the private bot token and creation of test channels in sdokdyg's server. Automated live transport checks passed; the two-account human rehearsal is now ready.

## Verified results

| Check | Evidence |
| --- | --- |
| Compilation | Final `npm.cmd run typecheck` passed. Both test commands also compiled the TypeScript entrypoints. |
| Default tests | Final `npm.cmd test`: 47 passed, two opt-in database tests explicitly skipped; 49 total, zero failures. This includes routing/sticky regressions, tagged participant state, button labels/styles, agreement attribution, silent button ACKs, exact private follow-up deletion targets, and temporary slash replies. |
| Native database tests | `npm.cmd run test:db`: two passed, zero skipped, against the retained local PostgreSQL 18.6 target. Files run sequentially so migration snapshots do not race the other suite's writes. |
| Additive migration | The first native run upgraded the actual existing schema from version 1 to 2. A later compiled `discord/runtime.js setup` returned `already_ready`. Aggregate JSON remains version 1. |
| Existing data | The offline checks preserved all seven original events and 89 audit rows. Before live work, the database held 12 events, 148 audit rows, and two retired Discord sessions. A fresh independent hash comparison after live work preserved all 12 prior events, all 148 prior audit rows, and both prior session records. |
| Existing CLI compatibility | The compiled local rehearsal completed on schema 2: event `6c9e2ddb-2440-48f4-8568-30a7532890a8`, 19 audit entries, nine prior events retained, A/C at 3 points and 1216 rating, B/D at 0 points and 1184 rating. This harness still uses an accelerated injected clock. |
| Ownership and transaction boundaries | Native tests verified global lease exclusion even with a different configured target, detection of termination of the test-owned lease connection, lease reacquisition, identity/canonical-card checks, interaction deduplication, and real-principal audit. A held aggregate row lock delayed clock sampling; retirement under that lock rejected a queued click. |
| Clock and restart rules | Native tests reject a foreign runner before sampling elapsed time, allow continuation from paused/persisted-expired state, and reject early/obsolete timer tuples without state/audit changes. Controller tests exercise actual short timeouts with a fake transport, including transient apply/read failures and expiry without a winner. |
| Card delivery | Fake-transport tests verify explicit creation, saved-ID reuse after controller startup/reconnect in setup/paused/expired states, stale-control refresh, convergence after an older blocked edit, explicit deleted-card repair, and no replacement send on forbidden or background failures. Ambiguous creation is attempted once; explicit refresh can retry a failed pin on the saved card. |
| Honest acknowledgments and shutdown | Fake tests preserve a saved acknowledgment when later reads/edits fail and prevent a mutation when shutdown happens during acknowledgment. The CLI has a bounded shutdown deadline and fixed error messages. Actual Gateway shutdown remains part of live validation. |

The domain regression also verifies participant judge requests, repeat-request idempotency, retention of attention during proposal replacement, and clearing on resolution. Existing readiness, pause-generation, proposal, correction, rollback, and health tests continue to pass.

The final native database run included the lease-termination assertions. Subsequent source changes addressed timeout retry, shutdown errors, token fallback, safe imports, and Gateway readiness. Final typecheck and all default tests passed afterward; these changes did not alter the database store or schema.

## Live checks on 12 October 2026

The ignored local harness used the actual production controller and Discord transport, a real Gateway connection, real REST operations, and the retained native PostgreSQL database. Its player/admin inputs and acknowledgment functions were synthetic. Audit interaction IDs begin with `synthetic-live:` so these actions cannot be mistaken for authenticated human clicks.

All 11 automated test groups passed. Event `20bb41a4-9547-4160-9bd1-8533fed9d403` finished at version 21 with 21 audit rows and practice winners A/C.

| Live check | Verified result |
| --- | --- |
| Access and registration | Authenticated as BoBoAssist in the exact authorized guild. Registered only the named guild command `/tcg-test`, with unrelated command IDs retained. The bot has the required text permissions and Manage Channels; it lacks Administrator and Manage Roles. |
| Private test area | Created one private category, the automated control text channel, two voice rooms, and a separate text channel accessible to the two supplied accounts. Existing guild channels and roles were not changed. A temporary permission probe channel was removed afterward. |
| Three cards | Explicit refresh created three bot-authored cards with persisted IDs and a pinned check-in. Repeated refresh and the injected reconnect hook reused those IDs. Unpin followed by explicit refresh restored the pin. All actual custom IDs fit Discord's 100-character limit. |
| Deleted card | Deleted only the newly created task-owned M2 card. Background refresh did not recreate it. Explicit refresh replaced M2 while keeping check-in and M1 IDs. |
| Permission failure | A task-owned scratch channel denied Send Messages. Discord returned HTTP 403/code 50013; the production transport classified it as forbidden. |
| Match rules | Synthetic actions against real stored state exercised scope/identity/canonical-card/ACK guards, early publication rejection, duplicate interaction handling, four check-ins, readiness, pause/resume, stale generations/revisions, judge attention, self-confirm rejection, dispute, resolution, and correction validation. |
| Real deadline | M2 ran for its actual 60-second duration. Exactly one system timer audit was persisted; expiry set judge attention and awarded no winner. A subsequent synthetic admin ruling finalized it. |
| Voice-room text | Send, edit, read, and channel permissions were verified in both voice rooms. Pin requests returned HTTP 400/code 50019 despite matching message/channel IDs and Pin Messages permission. The same pin endpoint succeeded in the regular text channel. Voice audio was not tested. |
| Runtime lifecycle | The production runtime connected, reused the same saved cards, and returned HTTP 200 from both loopback health endpoints. Invoking its SIGINT handler released the lease and stopped health. This was a handler invocation, rather than an operating-system signal test. |

The reconnect check called the controller hook; it did not induce or observe an actual Gateway resume. The automated harness observed four incoming Gateway interactions but did not route them as human test actions; those observations prove no player mutation or acknowledgment. Live 429 behavior, ambiguous network failures, and running-clock process recovery remain unverified. No rate-limit flood was attempted.

A subsequent two-account startup exposed that SDK login can finish before `clientReady`. The runtime and local helper now install the listener before login and wait for readiness with cleanup on failure, cancellation, or timeout. The failed startup produced no cards or audit entries; its empty event was retired without deleting history. The corrected helper reached live readiness successfully.

## Small implementation decisions

- Ownership uses one database-wide lock because the schema permits one active private session. A changed channel or application cannot bypass a running owner's lock.
- Message IDs and match state are durable; refresh scheduling remains in memory. Startup never creates missing cards. An explicit admin refresh repairs them, and an ambiguous creation can leave an inert stray card for manual removal.
- SDK timeout/5xx retries are disabled, including for initial POSTs. The adapter retries known-card updates; rate-limit handling remains with discord.js. SDK retry options are asserted offline; real Discord 429 behavior has not been exercised.
- Judge requests and expiry currently show attention on the card. Notification pings are not implemented; the supervising admin must watch the test channel.
- The health-only entrypoint stays separate. Starting `dev` does not read Discord settings or connect to Discord.

See the [README instructions](../README.md#private-discord-rehearsal) for configuration and commands. `db:discord-setup` and `discord:prepare` are local operations; `discord:register` and `discord:run` contact Discord. `.env.example` is a reference, not an automatically loaded configuration file.

## First human rehearsal and follow-up

The first two-account run received 11 genuine button interactions. Its audit confirmed seven real mutations: A/B check-in and readiness, two competing winner proposals, and A's dispute of B's proposal. The real timer expired without a winner; Discord's cards matched the disputed, expired state. Pause/resume and confirmation were not exercised. The runtime error log was empty, but it did not record why the other four interactions caused no state change.

The user then required match panels in assigned voice-channel chats and sticky check-in/match panels, referencing PokeBuilder. The follow-up implementation and live evidence are recorded below. The first human event was retired with all its match state and audit retained; its superseded bot panels were removed after the new layout was validated.

Check-in remains in [tcg-two-player-test](https://discord.com/channels/727211845420712078/1559448504470867968). Match panels now use [M1's assigned voice chat](https://discord.com/channels/727211845420712078/1559454537905864815) and [M2's assigned voice chat](https://discord.com/channels/727211845420712078/1559454539202039851). The first supplied account is A and the second is B. C/D and local admin operations are synthetic; the normal production requirement for four distinct players and a separate admin remains intact. The local helper seeds C/D check-ins and publishes after both actual accounts check in, then routes genuine A/B interactions through the production adapter. It does not inject A/B actions.

The voice-layout rehearsal was event `fe431770-3656-4dc3-a8db-d1aca89d6b0d`. Actual users later checked in, readied, paused with about 44 seconds remaining, and saved only A's resume consent. B subsequently confirmed A's proposed win. Its frozen clock was therefore correct, but the display did not clearly identify the missing B consent or remove the clock after finalization. This completed event and its audit were retained before the UX retest.

The UX rehearsal `f23a44df-eec5-486e-974b-09602860f0c2` was later finalized by the two real accounts and retained before the next UI update. The current fresh controls rehearsal is event `0cb6e67f-e9ee-4b49-a843-af701d1f8c9e`. State and canonical message IDs may advance as players act; use the database rather than old status-file snapshots as authority after a sticky move.

The task-owned PostgreSQL cluster remains running on loopback port 51948 for the rehearsal. The hidden local helper process was PID 70836 when controls readiness was verified. No Windows service was added. Credentials, test helpers, resource manifests, and detailed results are under ignored `.local/`; the token remains in ignored `.env`. All source changes remain local and uncommitted.

From both accounts, click Check in in the text channel, then Ready in M1's voice chat. The second Ready starts the one-minute clock. Pause if needed while switching accounts; both Resume consent clicks resume it. A can propose I won and B can Confirm or Dispute. To test sticky behavior, post a human message in check-in or a match voice chat and verify its panel moves below the message within about four to eight seconds.

## Voice routing and sticky validation

The final offline suite passed 41 tests; the explicit native database suite then passed both tests with no skips. Schema version remains 2. Optional match-channel IDs and durable sticky suspension use additive fields in the existing session JSON. Native tests verified suspension persistence and canonical compare-and-set; source and controller tests verified wrong-channel rejection and frozen routing.

The separate live transport harness passed four bounded cases: initial placement plus sticky replacement for M1, check-in, and M2. It used real Gateway login, real Discord POST/GET/DELETE/pin operations, and native PostgreSQL, with synthetic actor and human-message metadata injection. This is transport evidence rather than proof of an actual human MESSAGE_CREATE trigger. Bot/webhook/foreign-guild metadata produced no replacement; a human-message burst moved only M1 once. After replacement, the new canonical card existed remotely, the old card returned Unknown Message, and an old-card control changed no state. Check-in remained pinned and its exact bot-authored pin notice was removed. Match cards were placed only in their assigned voice chats and were not pinned.

Replacement sends once, reserves the slot durably, CAS-binds the new ID, then removes the old bot card. It shares the refresh queue, rerenders after concurrent state changes, and verifies a binding after an uncertain database reply before deleting a known new card. Ambiguous POSTs or incomplete cleanup suspend automatic reposts across restart. Explicit refresh follows channel inspection. The trigger ignores bots/webhooks, coalesces bursts with a cooldown and maximum wait, and requests Guild Messages without Message Content.

The user then posted from an actual account in check-in and M1's voice chat. Live Gateway handling replaced check-in about 4.4 seconds after the human post and M1 about 4.3 seconds after its post. Both new canonical cards were the latest remote messages; both old IDs returned Unknown Message. Check-in remained pinned, no sticky slot was suspended, match state stayed at version 2, and the error log was empty. M2 was unchanged because nobody posted there; its sticky replacement has transport-harness evidence, but not yet a real human trigger. Detailed tokenless evidence is in ignored `.local/private-discord-live/human-sticky-verification.json`.

Voice audio remains untested. Setup shows Ready after publication; running and paused expose the appropriate Pause/Resume action; expired cards retain both disabled and explain that judge resolution is required. Expiry never restarts or extends the clock. Actual pause/resume clicks in the new voice layout remain to be exercised after both real accounts check in and ready.

## Resume and temporary-reply UX follow-up

Paused cards now use a red strip and display the waiting players as actual user mentions, with the consent status. Other nonfinal cards use orange; completed cards use green and a concise winner line without an unused frozen clock or open proposal. Live REST editing verified green completed M1 and orange setup M2 using the previous real match state; paused rendering was verified offline.

Because embed mentions do not create notifications, the first resume consent can send one content mention to the remaining player. A claim under the aggregate lock records the pause generation in existing session JSON before attempting the POST. Duplicate claims and running-state claims return no reminder. Routine card edits and sticky reposts disable notification parsing. The reminder is followed by a panel bump and best-effort removal after eight seconds. A failed reminder does not undo the saved consent or trigger an automatic resend. The native suite passed both tests after adding the durable claim assertions.

Successful button actions now use `deferUpdate()` and update the shared panel without creating private success messages. Errors or pending-update warnings use a separate ephemeral follow-up; after eight seconds the bot deletes that exact follow-up through `interaction.webhook.deleteMessage(id)`. Slash commands use an ephemeral original and expire that original through `deleteReply()`. These are best-effort timers in the running process, not a durable deletion service. Button handling never deletes `@original`, which would target the shared panel after `deferUpdate()`.

Luna independently verified current official Discord interaction-webhook deletion routes and discord.js 14.27 implementation. Bots can delete ephemeral interaction messages while the token is valid; user Dismiss is not the only mechanism. `Message.delete()` uses the channel route and is unsuitable for ephemeral replies. Focused tests verified silent successful buttons, the exact private follow-up deletion ID, slash-original deletion, and preservation of committed consent on reminder failure. Actual client disappearance and the new notification/red-to-orange transition remain user-operated checks. Old success messages whose interaction tokens were not retained may still require manual Dismiss.

## Final button labels and participant attribution

The user reported the temporary-reply behavior was working better and confirmed the revised controls: no I lost; I won proposes the reporter's win; only the opponent may use green Agree or red Dispute; Resume is green. Discord has no orange button style, so Pause uses a neutral button labeled 🟠 Pause. Readiness, resume consent, proposal reporter, and waiting opponent are displayed with actual user mentions.

An open proposal disables I won until the opponent responds. A dispute re-enables it for a corrected proposal, preserving the agreed mutual-settlement rules. Shared controls remain visible to both players; the backend enforces opponent identity rather than pretending the shared message is user-specific. Existing legacy I lost custom IDs remain parsable for compatibility but are never rendered on new cards.

Player confirmation now records an optional `confirmedBy` field in the existing aggregate JSON so a final card can truthfully name who agreed. Old aggregates without it still load; a new proposal or admin resolution/correction clears it. The final offline suite passed 47 tests and the native suite passed both tests after these changes. The previous 22 events and 260 audit rows were snapshotted for preservation; the new rehearsal uses the same assigned voice chats.

To stop the task-owned helper from the repository directory, create its sentinel with `New-Item -ItemType File -Path .local/private-discord-live/STOP -Force`. Wait for `TWO_ACCOUNT_STOPPED` in `.local/private-discord-live/human.stdout.log` before stopping the task-owned PostgreSQL cluster using the command in [the rehearsal validation](REHEARSAL_VALIDATION.md#run-again-on-this-workstation).

Running-clock recovery across process restarts remains unsupported. Pause before planned restarts, or explicitly replace an interrupted practice session while the bot is stopped. Automatic room management, voice audio, open signup, multi-round tournaments, global ratings, DMs, backups, and production outage policy remain outside the production adapter.
