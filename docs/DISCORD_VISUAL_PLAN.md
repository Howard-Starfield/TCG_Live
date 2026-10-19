# Discord status images and GIFs

14 October 2026. Add artwork to existing panels, reminders, organizer notices and private replies. Preserve the previously approved labels, mentions, status strips, silent successful buttons and eight-second private-error cleanup. No human testing is requested during this slice.

## Reference findings

Inspected DudeBot.NET at `66c57f8f6e9cc0fa77966fa68ab58540cf8ace73` and Tradebot at `1131490e19e9c8f447e4ab4b2fd6438db3cfe157`. Their Discord helpers select one remote PNG/GIF thumbnail for each notification state; no SVG references or bundled image files were found in the inspected Discord projects. Relevant examples:

- [DudeBot notification helper](https://github.com/Havokx89/DudeBot.NET/blob/66c57f8f6e9cc0fa77966fa68ab58540cf8ace73/SysBot.Pokemon.Discord/Helpers/EmbedHelper.cs#L72-L134)
- [DudeBot online/offline status](https://github.com/Havokx89/DudeBot.NET/blob/66c57f8f6e9cc0fa77966fa68ab58540cf8ace73/SysBot.Pokemon.Discord/SysCord.cs#L192-L244)
- [Tradebot notification states](https://github.com/jonklee99/Tradebot/blob/1131490e19e9c8f447e4ab4b2fd6438db3cfe157/SysBot.Pokemon.Discord/Helpers/EmbedHelper.cs#L11-L113)

Reuse the state-to-thumbnail pattern with an independently implemented helper and original, locally packaged trainer-orb artwork. No reference code or third-party sprites are copied. Those projects' AGPL source licenses do not establish licensing for their separately hosted sprite assets.

## Small implementation

One catalog maps signup, check-in, setup, running, paused, proposal, disputed, expired, final, reminder, notice and error to small PNG/GIF files. Artwork uses an original colored trainer orb with clear state badges and restrained motion. Keep source SVGs and a reproducible offline generator alongside the assets; use committed PNG/GIF output at runtime, with no imaging dependency in the server.

Use an embed thumbnail referencing one local attachment, with stable versioned filenames `tcg-<state>-v1.gif` or `.png`. Main text and buttons remain readable and useful when images are not animated. Nonfinal match strips stay orange, paused red and final green. GIF frame motion carries no timer or match-state meaning.

On send/repost, upload one small visual. On known-card edit, retain the existing attachment if the desired filename already exists. When the visual changes, replace the old attachment with exactly one new file. Never repeatedly upload the same GIF on clock/sticky refresh. Resolve asset paths relative to the module, not cwd. Existing serialized card refresh remains the only card-update owner.

Private errors and admin slash responses become compact visual embeds; keep their full message text, no notification parsing, and existing exact-message deletion. Successful button clicks still create no private success messages. Resume reminders keep the actual targeted @mention in content and add a visual embed explaining that both players must Resume. Organizer movement-limit notices also use the shared visual helper. No new DMs, scheduled reminders, emoji-server management, hosting service or animation framework.

## Checks

Verify asset format, size and frame count; inspect a contact sheet/animated preview. Focused tests cover state selection, local attachment retention/replacement, silent ACK, private deletion, reminder mention whitelist and no-ping notices. Full offline tests should cover existing behavior. The domain, database schema and commands are unchanged, so a native database rerun is needed only if an integration concern appears.

Before rebuilding, stop the task-owned bot gracefully. Preserve the current event/canonical messages. After source checks, verify actual Discord send/edit accepts local images and GIFs without real player clicks or test pings, update only canonical bot panels, and restart the saved private session. Keep public-room activation blocked on the previously documented permission gap. Do not ask the user to test now; add visual cases to the return checklist.

## Opus review dispositions

Claude Opus 5.5 high effort approved with fixes before implementation (`.local/private-discord-live/visual-opus-review.json`). Accept its precise transport rules: reconstruct thumbnails with `attachment://` each edit, never reuse signed fetched CDN URLs; inspect fetched message attachments for retention across restart; omit both files and attachments on unchanged one-file edits, and use `attachments: []` plus one new file on replacement. Every new/sticky message uploads exactly one file. Always acknowledge buttons before uploads, retain exact follow-up deletion rather than deleting the shared original, and verify attachment retention with real REST send/edit. Cap assets at 128px/256KB. Keep the offline generator short and development-only; runtime has no imaging dependency. Multiple animated states remain in scope because the user requested GIFs across the notification experience, with static images for urgent errors/disputes/expiry.

Live REST inspection refined the review's attachment-list assumption: Discord returned an empty attachment list for a file consumed as an embed thumbnail. A direct edit using the same freshly reconstructed `attachment://` name without files/attachments preserved the exact CDN pathname and 96px image. Therefore the adapter also recognizes an embedded file from the fetched bot-authored message's official Discord attachment CDN pathname, scoped to the actual destination channel and exact catalog filename. This metadata is used only for identity; signed CDN URLs are never emitted in our edit payload. Foreign hosts, channels, filenames and authors do not qualify for retention. The real send/edit probe verifies this behavior across fetched messages rather than promoting mocked attachment-list behavior into a live claim.
