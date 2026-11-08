# Game artwork controls

## Scope and layout

An organizer chooses One Piece, One Punch Man or Pokémon in the existing authenticated dashboard, previews the supplied default tournament GIF, uploads a replacement banner or a compact thumbnail, resets either slot and chooses the active game artwork. This changes presentation only; no game rules, account system or database schema is added.

Keep the dashboard's current typography, palette, fields and buttons. Compare a new settings router against a focused Artwork panel/dialog: use the smaller existing navigation/dialog pattern rather than rebuilding the shell. The distinctive content is the actual per-game GIF beside a compact Discord-shaped preview, with plain labels for Tournament banner and Thumbnail. Show original state artwork as the thumbnail fallback and preserve readable state text and colors. Mobile stacks the controls and preview; keyboard focus and motion preferences use existing UI primitives.

## Storage and API

A separate strict profile under ignored `data/artwork/` holds active game and references for the two whitelisted slots per whitelisted game. Server-chosen content-hash filenames identify upload versions. Use atomic persistence and serialize mutations; never overwrite packaged defaults, application code or other games' files. Do not accept a browser-supplied filesystem path or remote image URL. Keep the original status artwork as the fallback when no active custom selection is configured.

Authenticated settings routes reuse the existing bearer/session, Host and Origin protections. Upload raw bytes through a separately bounded reader, leaving the 16 KiB JSON-reader limit unchanged. Limit each upload to 4 MiB and image dimensions to 4096 per side / 16 megapixels. Accept GIF, PNG and JPEG based on bytes and detected type, not the submitted filename. Reject empty, unsupported and obviously truncated inputs. Preview bytes are read through authenticated API calls into revocable browser object URLs; uploaded files are not added to the web static root.

The image CSP adds `blob:` only to `img-src` for these authenticated previews. Script, object, frame, form and base restrictions retain their existing policy. Runtime upload storage has a 64 MiB total budget; existing content-hash duplicates do not consume another copy.

The patched `image-size` 2.1.0 Buffer API provides type and dimensions without decoding all pixels. Its metadata validation is not a complete image integrity check; do not claim otherwise. Original supplied GIFs remain unchanged.

## Discord integration

Use the selected game's tournament banner for signup/check-in and its optional compact thumbnail override for match panels and reminders/notices/private errors. Keep state-specific orbs when a compact override is absent. Text, mentions, state colors, clocks, button semantics and eight-second private-error deletion remain unchanged.

Resolve files only through the store's validated references and whitelisted packaged assets. Content-hash attachment names identify versions; retain matching owned Discord CDN uploads during ordinary edits, replace attachments on changed artwork, and handle banner images separately from thumbnails. Selecting or clearing the active game and uploading/resetting its artwork automatically edits bound, non-suspended Discord panels through the existing controller queue. Inactive uploads are saved without changing live panels. Report applied or pending delivery after saving; ordinary retries edit existing panels only, while explicit Refresh panels remains the missing-card repair path. New notices, normal edits and sticky replacements use current settings.

## Verification

Check authenticated upload/preview/reset and cross-origin rejection; file size/type/dimension limits; strict profile/path containment; per-game and per-slot isolation; restart persistence; concurrent changes; safe fallback for absent/invalid files; actual default previews; object-URL cleanup; keyboard/mobile layouts; Discord banner/thumbnail retention and replacement; and unchanged notification/mention/control behavior. Verify actual Discord image delivery in the selected test server without adding fake players or changing the roster.

## Dependencies

Context7 resolved the image-size repository and documented its Buffer API and metadata-only limitation. The initially suggested 2.0.2 was deprecated and had known parser advisories; it was replaced before use with exact 2.1.0. The existing compatible Discord HTTP dependency was patched from undici 6.29.0 to 6.29.1. The resulting npm audit reports zero known vulnerabilities.
