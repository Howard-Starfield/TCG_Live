# Public match rooms validation

14 October 2026. Requested behavior and review decisions are in [the plan](PUBLIC_MATCH_ROOMS_PLAN.md). Human acceptance steps are in [the return test list](RETURN_TEST_LIST.md).

## Implemented and checked

- Opt-in public room mode is validated and frozen with session routing. Legacy private mode remains the default. Both rooms must be distinct same-guild voice channels with the dedicated name prefix, outside AFK.
- Complete overwrite plans provide public view/connect/history, deny ordinary spectators posting/new reactions/room commands, and grant the current pair, organizer and bot their intended access. The bot's explicit member overwrite retains its management permissions. Reopening removes the previous pair's chat grants. The original overwrite list is backed up once under ignored repository `data/discord-room-overwrites/` before any policy write.
- One serialized reconciler uses saved assignment, rereads state before writes/moves, coalesces events and discards pending work on stop. Failed policies wait for explicit Refresh or a changed plan/current policy. Background failures log once; admin actions show a precise pending-room warning without undoing a saved command.
- Connected players are placed after publication and on relevant voice changes while their match is unfinished. Disconnected users, AFK, spectators and the organizer are skipped. No-op destinations and move failures do not produce blind retries; move attempts are capped at three per minute, with a best-effort organizer warning. GuildVoiceStates is requested only in public mode.
- Typecheck and build passed. The full offline suite passed 65 tests, with two expected opt-in database skips. After the final background-warning shutdown fix, all 23 focused room/runtime/SDK tests passed.
- Both native PostgreSQL tests passed with no skips, including persisted/frozen public-mode checks. No native-test/store/session/config changes followed that run. The existing 29 event rows and 321 audit entries were individually hashed before testing and remained unchanged. New synthetic test events/audits were added separately.
- Exact-token scanning found zero bot-token matches in source, docs or task artifacts. No commit, push or publication was performed.

## Real Discord boundary

The new production permission validator was called read-only against both authorized match rooms. Both returned `requires bot Manage Roles permission`. The bot has Move Members and Manage Channels, but Manage Roles is absent at guild and channel scope. Everyone still lacks View Channel in both current rooms. No public overwrite replacement or real voice movement was attempted.

Live preflight evidence is `.local/private-discord-live/voice-access-production-preflight.json`; the reviewed plan is `.local/private-discord-live/public-rooms-opus-review-final.json`; preservation hashes are `public-rooms-before.json`. These are ignored, task-local artifacts.

The existing signup event `d5c8f55b-6a28-4a2b-a08f-7ee52354aeb7` was restored after testing. Signup is running again in its saved private mode; runtime reported ready, `/readyz` returned ready, and the startup error log was empty. Existing canonical panels and saved signup/audit state were retained. The verified startup process was PID 90092, recorded in the ignored runtime PID file; this is a point-in-time check, not a future health guarantee.

## Remaining live gate

The owner must grant permission-overwrite management (Discord Manage Roles) to BoBoAssist in both dedicated match rooms. Then prepare/enable a public-mode practice session and verify public view/connect, spectator chat denial, pair-only chat access and actual connected-player movement. Ordinary accounts are needed for permission-denial checks because the server owner/Administrator bypasses overwrites. The complete signup-to-match test needs four real players plus the separate organizer; no fake accounts were inserted into the live signup roster.

Mocked room effects and native persistence checks do not prove actual Discord client movement or spectator restrictions. Those checks remain explicitly pending in [the checklist](RETURN_TEST_LIST.md). Changing the public-mode setting to zero later does not itself restore private permissions.
