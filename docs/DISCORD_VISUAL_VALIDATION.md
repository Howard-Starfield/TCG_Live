# Discord visual validation

14 October 2026. See [the reviewed plan and reference findings](DISCORD_VISUAL_PLAN.md) and [the artwork overview](../apps/server/assets/discord/visual-contact-sheet.png).

## Completed

- Added 12 original trainer-orb visuals: nine looping GIFs and three PNGs, all 96×96 pixels. Each GIF has 12 frames. Runtime files range from 8,194 to 46,323 bytes. Editable SVGs and a short development-only Pillow generator are included; the bot has no new runtime dependency or image-hosting service.
- Inspected the contact sheet from the encoded PNG/GIF outputs, including later GIF frames. Shapes and badges are readable on a Discord-like dark background. No third-party source code or sprites were copied from the two reference projects.
- Panels, private responses, resume reminders and organizer notices select a state thumbnail. Existing text, button labels, status-strip colors and target mentions remain intact. Successful buttons stay silent. Private follow-ups retain their exact eight-second deletion, separate from the canonical panel.
- Typecheck/build passed. The complete offline suite passed 73 tests, with two intentional opt-in database skips. Tests cover state mapping, asset formats/sizes/dimensions/frame counts, retention/replacement, restricted asset filenames, owned-channel CDN metadata, slow-upload ACK order, private cleanup, organizer-only mentions and targeted resume reminders.
- Actual Discord REST/Gateway checks passed: GIF send, same-image edit with zero upload and an unchanged file pathname, PNG replacement with exactly one file, then GIF replacement with exactly one file. No signed CDN URL was placed in an outgoing edit. The temporary probe used suppressed notifications, no mentions/buttons, and was removed afterward.
- All three existing canonical cards were updated in their saved channels without changing their message IDs: signup uses the signup GIF and M1/M2 use setup GIFs. No missing-card repair was needed. Voice-chat attachments were accepted as well as the signup text-channel attachment.
- All 33 saved event rows and 356 audit entries matched their pre-change hashes. This slice changed presentation only; domain/store/schema/commands were unchanged and the native database suite was not rerun. Its last completed native run is recorded in the public-room validation record.
- Exact-token scan found no bot token in source, docs, scripts or task artifacts. The bot restarted on the same saved private signup event; runtime reported ready, `/readyz` returned ready, and its startup error log was empty. The verified startup PID was 40844, a point-in-time check rather than a future availability guarantee.

## Live finding incorporated

Discord omitted the embed-consumed image from the fetched attachment list, despite returning a working 96px thumbnail. A direct `attachment://<same name>` edit retained it without uploading again. The adapter now uses either the fetched visible attachment or a strictly validated bot-owned Discord attachment CDN pathname to identify an existing asset. It still reconstructs `attachment://` for the edit and never stores/reuses a signed CDN URL. Foreign author/host/channel/name paths cause a local replacement. Initial probe failures exposed this API detail; a later temporary-harness slot omission was fixed before the successful canonical checks.

The bot's current channels allow Attach Files. Startup checks now require it, and the public-room policy preserves it in the bot's own overwrite so a channel-only grant will not disappear when permissions are replaced. Public-room activation still awaits Manage Roles; visual work did not change channel privacy or move players.

Ignored evidence: `.local/private-discord-live/visual-opus-review.json`, `visual-live-verification.json`, `visual-before.json` and runtime logs.

## Deferred human checks

No player clicks or targeted live test pings were requested or performed. Actual Discord client animation, disabled-animation readability, private image replies and reminder appearance remain in [the return test list](RETURN_TEST_LIST.md) for when the user is ready. REST acceptance and mocked interaction tests do not establish those client checks.
