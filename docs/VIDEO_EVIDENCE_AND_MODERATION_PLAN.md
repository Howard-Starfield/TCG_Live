# Video Evidence and Moderation Plan

Status: **Phase 0 (foundation) implemented on `feat/evidence-moderation`.** The decisions below are final and override anything later in this document that contradicts them.

## Decisions (2026-11-14)

1. **Video is never bot-recorded.** Video evidence is a file or link submitted by a player or the admin. The bot records **audio only** (evidence kind `voice`).
2. **Voice bots are a pool.** The main bot covers one voice room. Each helper bot token the admin adds covers one more room at the same time. Rooms without a free bot are not monitored, and the dashboard shows that (`VoiceBotPoolDto.rooms[].botId === null`). Helper tokens live only in `data/voice-bots.json` (mode 0600), never in PostgreSQL, logs, errors or API responses.
3. **Recording mode:** `off` | `judge-call` (default) | `always`. Recordings keep the original Opus packets in Ogg, one file per player, with no re-encoding.
4. **Retention:** 7 days, 30 days (default), never, or a custom whole number of days from 1 to 365. Each evidence item has a hold flag. Held items are never deleted automatically.
5. **Keyword flags use Discord AutoMod.** The preset lists (profanity, sexual, slurs) can each be turned on or off. The admin can also edit custom word lists (add or remove words, plus an allow list). Each rule has its own action: `flag` (alert only), `block`, or `timeout` with a duration. Discord does not allow a timeout on the preset rule, so the preset rule offers only `flag` or `block`.
6. **Volume flags detect loudness spikes.** Settings: an enabled toggle, a sensitivity preset (low, medium or high), and advanced `thresholdDbfs`, `sustainMs` and `cooldownMs`. A spike is flagged on the dashboard, with an optional Discord notice to the organizer. **The bot never mutes anyone automatically.**
7. **Visible notice.** While recording or monitoring is active, the signup card and match room show a notice (built in a later phase). Settings carry an optional `noticeText` override.

Superseded below: the "Open product decisions" list (answered above), the `autoMute` option, "one monitored room at a time", and the original `ModerationSettingsDto` shape. The implemented shape is `packages/core/src/moderation-contract.ts`.

## Open product decisions (answered by the Decisions section above)

1. **Evidence source.** Is the MVP OK as "players submit their own clips (a file or a link), and the organizer reviews them in the dashboard"? A bot cannot record camera video or screen-share video (see §1).
2. **Voice audio recording.** Should the bot record match-room voice at all? If yes, when: only after **Call judge** or a dispute (recommended), or for the whole match?
3. **Consent model.** Should joining a tournament count as accepting a stated recording and monitoring notice? Or should there be a separate opt-in, where a player who declines is never recorded?
4. **One voice room per bot.** A bot can be in only one voice channel per server at a time. Is one monitored room at a time acceptable, or do you want extra helper bot applications later (Phase 4)?
5. **Text filter scope.** Discord AutoMod rules apply to the **whole server**, not just tournament channels. Can the bot have **Manage Server** permission and own server-wide rules?
6. **Loudness actions.** Should it only log and notify (recommended)? Or should it also be allowed to server-mute automatically (off by default)?
7. **Retention.** Default is to delete evidence 30 days after the event ends, unless the organizer places a hold. The default storage quota is 5 GiB. Are these OK?
8. **Minors.** Can players be under 18 (Pokémon events often include them)? If so, voice recording should stay off unless a guardian has consented.

## 1. Feasibility research

| Capability | Possible? | Basis |
|---|---|---|
| Receive voice audio from a match room | **Yes, with caveats.** It uses `@discordjs/voice` `VoiceReceiver`, which gives one Opus stream per user. | discord.js docs say Discord doesn't document audio receive, so "stable support is not guaranteed." |
| Receive camera video or Go Live screen share | **No.** | The bot API has no video-receive feature, and `@discordjs/voice` handles audio only. Getting video through a user account (a "self-bot") breaks Discord's Terms of Service. |
| Be in more than one voice channel in the same server | **No.** | A connection is keyed per server (`getVoiceConnection(guildId)`). Covering both M1 and M2 at once needs a second bot account. |
| End-to-end encrypted voice (DAVE) | Required for voice. `@discordjs/voice` 0.19.x handles it through `@snazzah/davey` (a Rust module with prebuilt Windows x64 binaries, so nothing compiles on install). | Third-party research reports that Discord has enforced DAVE since March 2026. The bot joins as a visible member of the call. |
| Encryption library (sodium) | **Not needed.** Node 24's built-in `aes-256-gcm` is enough. Packages like `sodium-native` and `libsodium-wrappers` are only fallbacks. | discord.js guide. |
| Opus decoding (needed for loudness) | Use **`opusscript`** (pure JavaScript/WebAssembly, no build tools). Avoid `@discordjs/opus` (native) because it often fails to install on new Node versions. | discord.js guide. |
| Text profanity filtering | Use Discord **AutoMod**. It has one preset rule per server (profanity, sexual content, slurs) with up to 1000 allow-list entries. It also allows up to 6 custom keyword rules, each with 1000 keywords and 10 regex patterns. | Discord AutoMod docs. Creating rules needs Manage Server. Receiving rule-trigger events needs the `AutoModerationExecution` gateway intent. |

**Node version to check:** one discord.js docs page lists a newer Node minimum (24.17) for the `main` branch, while the launcher pins 24.15.0. Pin `@discordjs/voice` to 0.19.2, which needs Node 22.12 or newer, and run its `generateDependencyReport()` in CI.

**Discord policy:** the Developer Policy has no rule written specifically about audio. Its general rules on "API Data" still apply: use data only for the stated purpose, publish a privacy notice, delete on request, and secure stored data. Discord says publicly that it doesn't record calls itself. Page fetches failed during research, so **re-read the live Developer Policy before shipping Phase 3.**

**Legal, at a practical level (not legal advice):**
- Several US states require consent from everyone on a recording: CA, FL, IL, MD, MA, MT, NH, PA and WA, with some others in certain cases.
- Under EU/UK GDPR, voice is personal data. Recording needs a lawful basis, a clear notice, limited retention, and a way to handle deletion requests.
- Germany makes secretly recording someone's spoken words a crime.
- The safe approach is: explicit notice and acknowledgement, record only the two players (never spectators, which the per-user stream makes possible), a visible "Recording" indicator, and automatic deletion.

## 2. Feature A: evidence options

| Option | Quality as evidence | Cost and risk | Verdict |
|---|---|---|---|
| (a) **Players submit clips** (a Discord file, or a link to YouTube, Twitch, Streamable, Medal or Drive) tied to a match or dispute | Best: it shows the board or simulator itself | Discord's free upload limit is about 10 MB, so links are the main path for longer clips. The bot must download attachments quickly because Discord's file links expire. | **MVP** |
| (b) **Bot records match-room voice** | Medium: it captures what players said, not the game | Consent burden, voice library, one room at a time | **Phase 3**, only after a judge call |
| (c) **Organizer records a judge screen share with OBS**, then uploads it in the dashboard | Good, but covers only one player's view | Manual, but the dashboard sits on the same PC so uploads are fast | **Included in the MVP** as an admin upload |

### Storage

- Files go in `data/evidence/<eventId>/<evidenceId>.<ext>`. Add `data/evidence/` to `.gitignore`.
- Each file's size, SHA-256 and declared type are recorded in the database.
- **Limits, editable later:**
  - Per file: 100 MB for player files, 2 GB for admin uploads.
  - Total quota: 5 GiB.
  - Free disk: refuse new writes when less than 2 GiB is free (checked with `fs.statfs`).
- **Allowed formats** (checked by reading the file's first bytes): MP4/MOV (H.264), WebM, Ogg/Opus, and MP3/M4A audio.
  - MKV is stored but marked "download only," because browsers can't play it. OBS records MKV by default; tell organizers to use OBS's "Remux" first.
  - No ffmpeg conversion in the MVP, so no native dependency.
- **Retention:** an hourly job deletes evidence once the event has ended and the retention period has passed (default 30 days). It skips anything on a hold or in an open dispute. Each deletion is a soft delete (the database row stays, marked `deleted`) plus removing the file, and is logged.
- **Backups:** evidence files are not in `pg_dump`. The Database page must say evidence is local-only and not backed up.

### Playback from the loopback dashboard

The problem: a `<video>` element can't send an `Authorization` header. Loading the whole file as a blob would also prevent seeking until it finished downloading.

**Solution: short-lived playback tickets kept in server memory.**
1. `POST /api/v1/evidence/:id/playback` (bearer token required) returns `{ url: "/api/v1/media/<ticket>", expiresAtMs }`.
   - The ticket is 32 random bytes and lasts 15 minutes.
   - It is tied to the session that requested it, and is invalidated when that session logs out or expires.
2. `GET` or `HEAD /api/v1/media/:ticket` is a `public` route in the existing handler.
   - It checks the ticket and that its session is still alive, and keeps the existing Host header check.
   - It supports **HTTP Range requests**: a single `bytes=a-b`, `a-` or `-n` range returns `206` with `Content-Range` and `Accept-Ranges: bytes`. A range that can't be satisfied returns `416`. Multiple ranges get a full `200` response.
   - It streams the file with `createReadStream({start, end})`.
   - The file path is resolved and checked to stay inside `data/evidence`.
   - Headers: `nosniff`, `Content-Disposition: inline` (or `attachment` with `?download=1`), and `Cache-Control: no-store`.
3. The existing `Referrer-Policy: no-referrer` header keeps tickets from leaking. If a ticket expires mid-playback, the player requests a new one and seeks back to where it was.
4. **CSP:** `default-src 'self'` already covers `media-src`. Don't add `frame-src`; link evidence opens in a new tab with `rel=noopener` and a warning that it is an external link.

### Database: migration `012_evidence_and_moderation.sql`

- **`tcg_evidence`**
  - Who and what: `id uuid` (primary key), `event_id` (references the events table), `match_id`, `proposal_revision` (null if not tied to a proposal), `kind` (upload, link or voice), `source` (discord, web or bot), `submitted_by` (Discord ID or `local-admin`), `seat`, `note`.
  - File details: `storage_path`, `original_name`, `mime`, `byte_size`, `sha256`, `duration_ms`, `external_url`.
  - State: `status` (pending, stored, failed or deleted), `hold`, `created_at_ms`, `deleted_at_ms`, `delete_reason`.
- **`tcg_ops_audit`**: an append-only log, separate from the domain audit so the result-replay logic and its mappers stay unchanged.
  - Columns: `id bigserial`, `event_id` (nullable), `guild_id`, `kind`, `actor_kind`, `actor_id`, `payload jsonb`, `occurred_at_ms`.
  - Kinds: `evidence.submitted`, `evidence.viewed` (logged when a ticket is issued), `evidence.deleted`, `evidence.hold`, `moderation.settings`, `automod.executed`, `voice.spike`, `voice.recording.start` and `voice.recording.stop`.
- **`tcg_moderation_settings`**: `guild_id` (primary key), `version int`, `settings jsonb`, `automod_rule_ids jsonb`, `updated_at_ms`, `updated_by`.

**Schema-guard pitfall.** Some setup code only accepts an exact list of public tables, so any new table will make startup refuse:
- `TABLES_V2_DIRECTORY` in `apps/server/src/rehearsal/store.ts`
- `names === base,tcg_tournament_directory` in `apps/server/src/tournaments/directory.ts`

Add a separate `setupEvidenceSchema()` function in a new `apps/server/src/evidence/schema.ts`, called from `scripts/guided-launch.mjs` after `setupTournamentDirectory()`. Then extend each guard to also accept the exact table list that includes the three new tables. Write tests for both lists.

### Submission flow

- **Discord:** add a **Submit evidence** button to the match card while the match needs a judge, and for 24 hours after it finishes.
  - The button opens a modal with a file upload field (discord.js 14.27 includes `FileUploadBuilder`; confirm it before building) plus a link field and a note.
  - Fallback: `/tcg-test evidence match:<M#> file:<attachment> link:<url> note:<text>`.
  - Slash-command attachments arrive as resolved data, so **no Message Content intent is needed.**
  - Only the two seated players and the organizer can submit, checked against the saved identity map the same way `controller.ts` checks button presses.
  - The bot downloads the attachment immediately into a temporary file with a size cap, computes the SHA-256, checks the file type, then moves it into place.
- **Dashboard:** in the match detail, add **Add evidence** (stream upload from the organizer's PC, or paste a link).

### Admin review UI

- `NeedsYou` judge cards show **Evidence (n)**.
- That opens an `EvidenceDrawer`:
  - a list sorted by time, showing submitter seat, note and size
  - a `<video>` or `<audio>` player
  - **Download**, **Hold**, and **Delete (reason required)** buttons
  - a link to the dispute's proposal revision
- The Matches tab gets an evidence column. The Audit tab gets an "Evidence and moderation" filter that reads `tcg_ops_audit`.

## 3. Feature B: moderation

### Text: use Discord AutoMod, not a custom filter

**Why AutoMod:**
- It blocks a message *before* it is posted.
- It keeps working while the PC or bot is offline.
- It needs no privileged Message Content intent.
- A custom filter would delete messages only after they appeared and would need Message Content plus Manage Messages.

**How it works:**
- The bot owns rules named `TCG Live – preset` and `TCG Live – custom words`. Their IDs are stored in `automod_rule_ids`.
- Saving settings syncs to Discord: create, modify, or enable/disable the rules.
- If the server already has its own preset rule (only one is allowed), the dashboard shows "managed elsewhere" and only offers the custom keyword rule.
- **Channel scope:** AutoMod only supports *exempt* channels and roles (up to 50 each), so "match rooms only" means exempting the other channels. The UI explains this.
- **Actions:**
  - Block the message (with a custom reply).
  - Send an alert to the organizer channel.
  - Time out the author, which is only available for custom keyword rules.
- Rule-trigger events arrive through the `AutoModerationExecution` intent. Each one is logged to `tcg_ops_audit` and pushed to the dashboard's live stream.

### Voice loudness-spike detection

- **Pipeline:**
  1. `receiver.subscribe(userId)` for **the two players only**.
  2. Decode Opus to 48 kHz PCM with `opusscript`.
  3. For each 20 ms frame, compute peak and RMS loudness in dBFS.
  4. Smooth with a short-term window (default 100 ms).
- **Trigger:** the short-term RMS stays at or above the threshold for the sustain time.
- **Defaults:** threshold −8 dBFS (range −30 to 0), sustain 400 ms (100–3000 ms), cooldown 60 s per player (5 s to 10 min).
- **Sensitivity presets:** Low, Medium and High fill in these values. An "Advanced" section shows the raw numbers.
- **Expect false positives and misses:** Discord clients apply their own volume leveling and noise suppression, so measured loudness varies by player setup.
- **CPU:** Discord only sends audio while someone is speaking. That means at most about 100 decodes per second for two speakers, well under 5% of one core per monitored room. Each bot in the pool covers one room.
- **Actions:**
  - Logged to the ops audit and the dashboard (always on).
  - Optional Discord notice to the organizer, rate-limited.
  - No automatic mute (decision 6).
- **Scope options:** `judge-call` (only rooms with an open judge call or dispute, default) or `always` (every room a pool bot covers).
- Room-placement code in `match-rooms.ts` must ignore voice-state changes from the main bot and every helper bot.

### Consent and notice

- Signup panel text: "Matches may be audio-monitored/recorded when a judge is called; recordings auto-delete after N days." This applies only if decision 3 is approved.
- While voice is active, the match card shows **"🔴 Audio monitoring/recording active"** and the bot posts a one-time notice in the voice room's chat.
- If a player has declined, the bot never subscribes to their audio.

### Settings type in `packages/core`

Implemented in `packages/core/src/moderation-contract.ts` (superseding the earlier sketch):
- **text:** `enabled`, `preset{enabled, presets{profanity,sexual,slurs}, action: flag|block, allowList[]}`, `customLists[{id,name,enabled,words[],regexPatterns[],allowList[],action: flag|block|timeout,timeoutSeconds}]`, `alertChannelId`, `blockMessage`, `exemptChannelIds[]`, `exemptRoleIds[]`
- **voice:** `enabled`, `scope`, `sensitivity: low|medium|high|custom`, `thresholdDbfs`, `sustainMs`, `cooldownMs`, `notifyDiscord`, `notifyChannelId` (no `autoMute`)
- **recording:** `mode: off|judge-call|always`; **retention:** `days: 1-365 | null` (null = never); `noticeText` (null = default)
- `guildId`, `version`, `updatedAtMs`. PUT sends `{ expectedVersion, settings }`; a stale version answers 409 with `current`.
- Upload limits, quota and free-space floor are constants in `packages/core/src/evidence-contract.ts`, not settings.

## 4. Phased delivery

### Phase 0: decisions and groundwork (implemented)
- Contracts: `packages/core/src/{evidence-contract,moderation-contract}.ts`. Migration `012_evidence_and_moderation.sql` adds `tcg_evidence`, `tcg_ops_audit`, `tcg_moderation_settings` and `tcg_moderation_flags`. `setupEvidenceSchema()` runs from the launcher and `npm run db:evidence-setup`. The exact-table-list guards live in `apps/server/src/rehearsal/schema-tables.ts`.
- Stores, routes and seams: `apps/server/src/{evidence,moderation,ops,voice}/`. The Discord feature seam is `apps/server/src/discord/{features,feature-registry}.ts`.
- Still to do: record these decisions in `docs/TCG_BOT_DECISIONS.md`.
- Add `CAPABILITIES += 'evidence.read','evidence.manage','moderation.manage'` in `packages/core/src/admin-contract.ts`, following the contract-change procedure in `docs/ADMIN_DASHBOARD_PLAN.md`. Grant them in `admin/commands.ts`.
- Write the migration 012 file and the schema-guard changes, with tests.
- **Done when:** the existing `test` and `test:db` suites pass, and the guarded setup accepts both the old and new table lists.

### Phase 1: evidence MVP (uploads, links, playback)
- **Add:**
  - `apps/server/src/evidence/{store.ts,schema.ts,routes.ts,range.ts,tickets.ts,retention.ts,discord-submit.ts}`
  - `packages/core/src/evidence-contract.ts`
  - `apps/web/src/features/evidence/{EvidenceDrawer.tsx,EvidencePlayer.tsx,api.ts}`
- **Change:**
  - `admin/http/handler.ts` (add routes, support `HEAD`)
  - `admin/mount.ts`
  - `discord/controller.ts` and `cards.ts` (button and modal)
  - `discord/runtime.ts` (registering `/tcg-test evidence`)
  - `features/console/NeedsYou.tsx`, `features/lists/MatchesTab.tsx`, `AuditTab.tsx`
  - `.gitignore`, `README.md`
- **Routes:**
  - `GET` and `POST /api/v1/events/:id/matches/:m/evidence`
  - `POST /api/v1/evidence/:id/playback`
  - `PATCH /api/v1/evidence/:id` (hold)
  - `DELETE /api/v1/evidence/:id` (reason required)
  - `GET`/`HEAD /api/v1/media/:ticket`
- **Tests:**
  - range parsing (all the cases above, plus 416)
  - ticket expiry and revocation on logout
  - path containment
  - file-type checking
  - quota and free-space refusal
  - retention skipping held items and open disputes
  - Discord submit rejecting non-participants
  - attachment size cap
  - web drawer rendering and seek (re-requesting an expired ticket)
- **Done when:**
  - A 60 MB MP4 sent as a Discord attachment appears under the dispute within 10 seconds, with a matching SHA-256.
  - The admin can seek anywhere without downloading the whole file.
  - A ticket stops working after logout or after 15 minutes.
  - Every submit, view and delete appears in the Audit tab.

### Phase 2: text moderation (AutoMod)
- **Add:**
  - `apps/server/src/moderation/{settings.ts,automod.ts,routes.ts}`
  - `apps/web/src/features/moderation/{ModerationSettings.tsx,ModerationEventsTab.tsx}` (opened from the account menu, like "Game artwork…")
- **Change:** in `discord/sdk.ts`, add the `AutoModerationExecution` intent when moderation is enabled. Onboarding checks Manage Server.
- **Routes:**
  - `GET` and `PUT /api/v1/moderation/settings`
  - `POST /api/v1/moderation/automod/sync`
  - `GET /api/v1/moderation/events?after=`
- **Tests:**
  - settings-to-AutoMod-payload mapping, including limits (1000 keywords, 60 characters, 10 regex)
  - handling an existing preset rule
  - version conflict
  - validation errors
- **Done when:** toggling the filter off disables the Discord rules within one save, a blocked word in a match room appears in the dashboard within 5 seconds, and a missing permission shows a repair message.

### Phase 3: voice monitoring and judge-call audio recording
- **Dependencies:** `@discordjs/voice@0.19.2` (pinned; brings `@snazzah/davey`) and `opusscript`. No sodium and no `@discordjs/opus`.
- **Env opt-in:** `TCG_DISCORD_VOICE=1`, strict 0/1 and off by default, matching the repo's existing env flags.
- **Add:** `apps/server/src/voice/{connection.ts,loudness.ts,recorder.ts,ogg-writer.ts}`
- **Recording format:** one Ogg Opus file per player, with no re-encoding. Silence frames are inserted for gaps so timestamps line up. The dashboard plays the two player tracks side by side, synced.
- **Change:** `match-rooms.ts` (ignore the bot), `cards.ts` (Recording badge), signup panel text.
- **Tests:**
  - `loudness.test.ts` using synthetic sine waves: −3 dBFS for 500 ms triggers; −20 dBFS doesn't; the cooldown suppresses repeats.
  - Spectator user IDs are never subscribed.
  - Recording stops when the judge resolves the match or the bot shuts down.
  - The `generateDependencyReport()` snapshot shows no native compilation.
- **Done when:**
  - On a clean Windows launcher install, `npm ci` succeeds without build tools.
  - A Call judge in M1 starts recording within 3 seconds, with a visible notice.
  - CPU stays under 5% of one core with two speakers.
  - The recording plays back in the Evidence drawer.

### Phase 4: later
- (Moved into Phase 3 by decision 2: helper bot accounts form the voice pool.)
- An opt-in rolling 2–5 minute pre-roll buffer, saved only when a judge is called.
- A single mixed audio track.
- Optionally archiving link evidence locally.
- An off-PC backup of evidence.

## Sources
- [discord.js voice installation guide](https://discordjs.guide/voice)
- [@discordjs/voice docs](https://discord.js.org/docs/packages/voice/main)
- [@discordjs/voice on npm](https://www.npmjs.com/package/@discordjs/voice)
- [Discord Auto Moderation API](https://docs.discord.com/developers/resources/auto-moderation)
- [Discord policy updates, Aug 2025](https://discord.com/safety/important-policy-updates)
- Third-party research, verify independently: [DAVE in Node libraries (mia-cx #17)](https://github.com/mia-cx/discord-mcp/issues/17), [bots receiving voice (mia-cx #18)](https://github.com/mia-cx/discord-mcp/issues/18)
