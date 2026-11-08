# Implemented: game-specific artwork and dashboard uploads

Requested 7 November 2026 during onboarding work. Keep this separate from the current startup/channel-selection slice.

## Prepared now

- Copied the supplied One Piece, One Punch Man and Pokémon tournament GIFs unchanged into `apps/server/assets/games/<game>/gifs/tournament.gif`.
- Created per-game `thumbnails/` slots. No thumbnail images were supplied, so those slots remain empty.
- Verified all three copies against the original SHA-256 hashes. Each supplied GIF is under 1 MB.

## Delivered controls

- An authenticated dashboard artwork section lets the organizer choose a game, upload GIF/image artwork, preview it, and restore the packaged default.
- Clearly distinguish tournament/banner artwork from compact status thumbnails. Keep the existing text, mentions, state colors and controls readable.
- Validate actual file type, dimensions and size server-side; use server-chosen filenames and an ignored runtime upload directory. Never let uploads overwrite application code, packaged defaults or other games' files.
- Store only the chosen artwork references in local configuration; do not add a game rules engine as part of artwork selection.
- Use existing attachment retention/replacement so normal refreshes do not repeatedly upload unchanged images. Keep a usable default when custom artwork is absent or invalid.
- Verify restart persistence, game isolation, bad/oversized files, preview/reset and real Discord image delivery before claiming the upload feature is complete.

Current source structure is documented in [the game assets README](../apps/server/assets/games/README.md). Upload, preview, per-slot reset and active-game selection are available from the dashboard account menu → Game artwork. Actual custom and packaged GIF delivery, attachment reuse and reset were verified in Discord. See [the validation record](LAUNCHER_ARTWORK_VALIDATION.md). Native PNG/JPEG and animation-disabled client checks remain on the return list.
