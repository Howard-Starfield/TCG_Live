# Helper bots: research, critique, and plan

Status: **plan, waiting on the decisions in §6.** Nothing here is built yet.

## 1. What "helper bot" means elsewhere

| Meaning | Example | Mechanism |
|---|---|---|
| **A. Voice clones** | Jockie Music (4 free instances, up to 6 paid), Green-Bot (3), Beatra (2–5) | Several separate bot applications run the same engine, each covering one voice channel. A bot can only be in one voice channel per server, and Discord dropped the request to lift that limit. |
| **B. White-label / branded bot** | MEE6 Bot Personalizer, YourBot, BotGhost; Carl-bot Premium only changes the in-server avatar and banner | You create your own application and hand its token to the service, which runs its features under your bot's name and avatar. |
| **C. Sharding** | Large public bots | One application split across gateway connections. It only matters past about 2,500 servers, so it doesn't apply here. |
| **D. Failover / backup bot** | Hobby setups | A second token takes over if the first fails. |
| **E. Rate-limit spreading** | Mass-DM and raid tools | Several tokens share bulk API calls. This is circumvention and breaks Discord's developer terms. |
| **F. Tournament integrations** | start.gg / Battlefy bots | Separate products, not helpers. |

**Policy:**
- Extra bot applications that you own are allowed.
- Using a user account as a bot (a "self-bot") is not.
- Rate limits apply to each bot separately. Spreading load across bots on purpose to get around them is the misuse described in E.

## 2. How each meaning fits a one-PC TCG organizer

- **A (voice clones): already built, and worth extending.**
  - The main bot plus up to 10 helpers (`MODERATION_LIMITS.voiceHelperBots`) cover rooms through `planVoiceAssignments`.
  - **High value**, but today it's only a token list. It has no setting per room, no setup help, and no per-helper health or permission check.
  - **No policy risk.** The real cost is that every helper is another Developer Portal application, invite and token for the organizer to manage.
- **B (branding): low value.**
  - The Developer Portal already sets each bot's name and avatar, and changing a username through the API is heavily rate-limited.
  - A **per-server nickname** ("TCG Recorder 2") is cheap and worth having, because it tells players which bot is recording them.
  - Fully white-labelling the main bot isn't useful when you're the only operator.
- **C (sharding):** doesn't apply.
- **D (failover): pushing back, not building.**
  - Buttons, modals and slash commands belong to the main application, so presses on cards it posted go to it. A helper can't answer those presses, can't own the registered commands, and can't edit the main bot's messages.
  - Failover would mean re-registering commands and reposting every card, which amounts to a second runtime.
  - If the main token is revoked, the fix is to paste a new token.
- **E (rate-limit spreading): pushing back, not building.**
  - It conflicts with Discord's policy against getting around rate limits.
  - Each helper would also need Manage Roles or Send Messages in many places, which makes a leaked token far more dangerous.
  - Bulk roles and announcements already queue. They're slower, and that's fine.
- **F:** out of scope.

**Video can't be recorded by any bot.** The bot API can't receive video or screen share, so helpers record audio only. Video comes from clips players upload or from the organizer recording with OBS.

## 3. Current-code findings that matter

- **Helper token file:** `voice/tokens.ts` stores tokens in `data/voice-bots.json` with `mode 0600`.
  - Windows effectively ignores that mode, so the file is protected only by the user-profile folder permissions. That's the same protection as the main token in `.env`.
  - We'll document this instead of adding Windows-level encryption, because the attacker in both cases is the same Windows user.
- **Wrong invite wording:** `apps/web/src/features/moderation/VoiceBots.tsx` tells users to invite helpers with "Connect and Speak".
  - Helpers only need View Channel and Connect. They never speak, and the main bot posts the monitoring notice.
  - **Fix the UI text.**
- **Login failures are permanent:** `HelperBotTransport` treats every login failure as permanent until the helpers are reloaded, so a network blip at startup disables a helper for the whole event.
  - Fix: an invalid token (close code 4004) stays failed, and anything else retries with backoff.
- **Room coverage is global only:** which rooms get a bot depends only on the global settings. There's no setting per room.
- **Room settings storage:** keep them in the existing versioned `tcg_moderation_settings.settings` JSON, so no migration or schema-guard change is needed.

## 4. Proposed design

### 4a. "Bots" tab in Admin tools
Requires `moderation.manage`. `VoiceBots.tsx` moves there, and the voice section of Moderation settings links to it.

- **One card per bot (main and each helper):**
  - label, nickname, avatar, kind, status, assigned room
  - last time it connected, and its last error (from a fixed list of error codes)
  - enabled toggle
  - actions: Verify, Retry, Replace token, Copy invite link, Remove
- **Capacity banner,** for example "This event: 6 rooms · 4 bots → 2 rooms unmonitored when all need coverage":
  - **Disk:** about 30 MB per player-hour at 64 kbps (raw Opus, no re-encoding), so about 60 MB per room-hour. For example, 8 rooms × 4 h on `always` is about 1.9 GB, measured against the 5 GiB quota and the 2 GiB free-space floor.
  - **CPU:** under 5% of one core per room with loudness detection on; recording alone is nearly free.
  - **Memory:** measured during rehearsal.

### 4b. Guided helper setup (the main value)
1. Open the Developer Portal and create a **New Application** (external link).
2. On the Bot page:
   - turn off **Public Bot**
   - turn off **Requires OAuth2 Code Grant**
   - leave privileged intents off
   - reset the token and copy it
3. Paste the label and token. The server then:
   - validates the token
   - refuses the main bot's own token
   - logs in once and calls `GET /applications/@me`
   - stores the application ID (not a secret)
4. Generated invite link: `https://discord.com/oauth2/authorize?client_id=<applicationId>&scope=bot&permissions=<bits>&guild_id=<guildId>&disable_guild_select=true`. The permission bits come from the `voice.rooms` requirement in `permissions/table.ts`.
5. **Verify** reports:
   - whether the helper is in the server
   - View Channel and Connect in each current match room, checked with the helper's own client
   - a warning if `bot_public` is true
   - a warning if the helper has Administrator or Manage Server (it should only be able to join voice)
   - nickname

### 4c. A setting for each room
Add `voice.rooms: Record<voiceChannelId, VoiceRoomPolicy>` to the moderation settings. It's keyed by voice channel ID because rooms stay the same across events while match IDs change.

```ts
interface VoiceRoomPolicy {
  coverage: 'auto' | 'always' | 'never';     // auto = follow global scope/recording rules
  recording: 'inherit' | 'off' | 'judge-call' | 'always';
  priority: 'normal' | 'high';                // high rooms are covered before normal, after judge calls
  pinnedBotId: string | null;                 // preferred bot; free for others when this room needs none
}
```

`planVoiceAssignments` stays a pure function with these rules:
- `never` rooms are dropped.
- Rooms are ordered judge-call, then `high`, then `normal`.
- A pinned bot goes to its room whenever that room needs coverage.
- A judge call can take a pinned bot from a room without one.
- Disabled helpers are never used.

The room grid shows each match room with its policy controls, its current bot and its status (monitored, recording or unmonitored).

### 4d. Health and auto-reconnect
- **Login failures:** split into invalid token (stays failed) and transient (retries after 30 s, backing off to 5 min).
- **Dropped voice connection:** the bot rejoins through the existing retry path.
- **Live state:** `lastReadyAtMs`, `lastErrorCode` and `consecutiveFailures` per bot.
- **Organizer notice:** a rate-limited notice goes out when a helper covering a judge-call room drops.

### 4e. Optional: per-server nickname
Set with `PATCH /guilds/{id}/members/@me {nick}` using the helper's own token. The dashboard won't change usernames or avatars.

### Not building
- failover
- rate-limit spreading
- a white-labelled main bot
- sharding
- video recorded by a bot
- more than 10 helpers
- Windows-level encryption of the token file

## 5. Phased plan

### Phase H1: helper setup and health (S–M)

**Server:**
- `voice/tokens.ts`:
  - file `version: 2` adds `applicationId`, `enabled` and `nickname`; v1 files are migrated on the next save
  - adds `replaceToken(id, token)` (must be the same bot user) and `update(id, {label, enabled, nickname})`
  - tokens stay in the file only
- `voice/connection.ts`:
  - sort login errors into invalid-token and transient
  - `verify(channelIds)` returns a report with no token in it: membership, application info, permissions per channel, and a warning for overly broad permissions
  - `setNickname()`
- `voice/monitor.ts`: retries with backoff, skips disabled helpers, and adds health fields to the live state.
- `voice/pool.ts`: passes health through and builds `inviteUrl`.

**Routes** (`moderation/routes.ts`, all `moderation.manage`):
- `PATCH /api/v1/moderation/voice-bots/:id`
- `PUT /api/v1/moderation/voice-bots/:id/token`
- `POST /api/v1/moderation/voice-bots/:id/verify`
- `POST /api/v1/moderation/voice-bots/:id/retry`

**Contracts:** `VoiceBotStatusDto` gains `enabled`, `applicationId`, `inviteUrl`, `lastReadyAtMs`, `lastErrorCode` and `nickname`. Add `VoiceBotVerifyReportDto` and an error-code enum.

**Permissions:** `voiceHelperInviteBits()` in `permissions/table.ts`.

**Web:**
- new `features/admin-tools/bots/{BotsTab,BotCard,AddHelperWizard,VerifyReport}.tsx`
- one registry entry
- a link from the voice section of Moderation settings
- fix the "Speak" wording

**Tests:**
- v1 → v2 file migration
- `replaceToken` refuses a different bot
- no response, log line or audit row contains the token
- login-failure classification
- backoff timing
- `verify` against a fake guild
- invite permission bits match the permission table
- web wizard

**Done when:**
- A new helper can go from pasted token to verified without leaving the dashboard, apart from the Developer Portal and the invite page.
- A 60-second network drop at startup no longer leaves helpers failed.
- The token appears in no response, log or audit row.

### Phase H2: room settings and capacity (M)
- **Settings:**
  - add `voice.rooms`, defaulting to `{}`
  - at most 50 entries
  - room IDs must be valid snowflakes
  - a pin to a missing bot falls back to `auto`
- **Server:**
  - `planVoiceAssignments` handles `never`, priority and pins
  - the coverage loop in `monitor.ts` reads each room's policy, and `recording` overrides `shouldRecord`
  - deleting a helper removes its pins
- **Saving:** uses the existing versioned `PUT /api/v1/moderation/settings`, which returns 409 on a stale version.
- **Web:** `bots/RoomGrid.tsx` and `bots/CapacityBanner.tsx`.
- **Tests:**
  - planner cases
  - settings validation and the 409 path
  - a room set to `recording: 'always'` records while the global setting is `judge-call`
- **Done when:**
  - Setting a room to `never` makes its bot leave within one reconcile.
  - A pinned helper goes to its room on the next coverage pass.
  - The banner's shortfall matches the rooms actually left unmonitored.

### Phase H3 (optional, S): nicknames

## 6. Decisions for you
1. **Bots UI:** put it in a new Admin tools "Bots" tab. *Default: yes, with a link from Moderation settings.*
2. **Room settings key:** key them by voice channel ID, so they carry over between events. *Default: yes.*
3. **Rooms above the global setting:** a room can record more than the global setting allows (for example `always` while the global setting is `judge-call`). *Default: yes, and that room still shows its monitoring notice.*
4. **Judge calls vs pinned bots:** a judge call can take a pinned bot away from a room without one. *Default: yes.*
5. **Helper nicknames:** helpers can have a per-server nickname. *Default: yes; the dashboard never changes avatars or usernames.*
6. **Failover and rate-limit spreading:** *Default: build neither, and keep the 10-helper limit.*

Sources: discord-api-docs discussion #5529; Beatra, Jockie, MEE6 Personalizer, YourBot documentation; discord-api-types. Check the request fields for Modify Current Application and Modify Current Member against the official docs before building H1 and H3.
