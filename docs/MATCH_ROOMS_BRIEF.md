# Brief: bot-managed match rooms, room chat transcripts, and post-event clean-up

Branch: `feat/auto-voice-rooms`. This is planned work by an Opus planner, with decisions by the user. Agents work with **disjoint file ownership**: never edit a file you don't own. If you need something across a boundary, use only the interfaces here. The same rules apply as in the earlier briefs (`docs/TOURNAMENT_ROLES_BRIEF.md`).

## Decisions (final)
1. **Setup:** setup no longer asks for M1/M2 voice rooms. It offers an optional category ("Put match rooms in…", or "create one").
2. **Room pool:** the bot creates rooms when a round publishes and reuses them across rounds and events, as a pool of numbered "tables". Table k serves match Mk.
3. **Naming:**
   - **Template:** the default is `🎮 {match}`. The tokens are `{match}` (M3), `{n}` (3), `{table}` (Table 3), `{round}` (Round 1), `{event}` (sanitized event name) and `{game}` (game label, for example "One Piece"). `{stage}` is refused with "coming with brackets".
   - **Presets:** `🎮 {match}`, `{table} · {round}`, `⚔️ {round} · {match}`.
   - **Renames go through a queue that respects Discord's 2 renames per 10 minutes per channel.** They run on a dedicated REST instance with `rejectOnRateLimit`. Never call `setName` or `edit({name})` on the client's REST; it can hang for up to 10 minutes.
4. **Existing configured rooms** (the old M1/M2 picks) join the pool as **adopted** rooms and are **renamed to the template** at the next event. The bot keeps their original name and overwrites so it can restore them at clean-up.
5. **A template change renames right away**, through the queue, and the UI shows "Queued — Discord allows 2 renames per 10 minutes."
6. **A rename made directly in Discord** becomes that room's custom name. "Use template" switches it back.
7. **Over 50 rooms:** the bot uses extra categories named `{game} {from}–{to}`, for example "One Piece 1–50" and "One Piece 51–100". Each holds up to 50 rooms. The game label comes from the event's game, with "TCG" as the fallback.
   - If the admin chose a category in setup or settings, it's used for tables 1–50.
   - Overflow categories are bot-created and named as above.
   - The hard stop is the server's 500-channel total: refuse with a clear `RuleError` that names how many channels are free.
8. **Clean-up after an event: delete everything the bot created and restore the baseline, only after the admin confirms in the dashboard.**
   - **Baseline:** a "Server baseline" set of the voice channels and categories that are the server's normal layout. It's captured at setup or first start, pre-filled with every voice channel and category that existed before the bot created any, and editable in Settings.
   - **Clean-up preview:** when an event retires or ends, the dashboard shows a clean-up preview:
     - **Will be deleted:** bot-created rooms and bot-created categories that are not in the baseline.
     - **Will be restored:** adopted channels get their original name and overwrites back, from the backup taken before the bot changed them.
     - **Kept:** baseline channels.
   - **Nothing is deleted until the admin presses Confirm.** Occupied rooms are skipped and listed.
   - **The bot never deletes a channel it didn't create**, even if it's missing from the baseline.
   - The voice settings per room (Bots tab) for deleted rooms are dropped. For adopted rooms they're kept.
9. **Room chat: archive, then clear.**
   - **Archive:** before a room is given a new match, and before it's deleted at clean-up, the bot saves that match's room text chat as a **match room transcript** tied to `(eventId, matchId, channelId)`.
   - **Clear:** then it deletes the room's chat messages (bulk delete works for messages under 14 days old; older ones are skipped and noted).
   - **Without the Message Content intent:** transcripts keep the author, time and attachments, but not the text, and the UI says so.
   - **Retention:** transcripts follow the evidence retention setting (default 30 days). Held items are kept.
   - **Where they show:** viewable in the match drawer ("Room chat") and exportable from the event (JSON/CSV, like ticket transcripts).
10. **Permissions:** drop `ManageRoles` from the bot's channel overwrite in `roomPlan`. Only administrators can put Manage Roles in a channel overwrite; the bot keeps managing overwrites through its server-level Manage Roles. Archiving and clearing need View Channel, Read Message History and Manage Messages on the rooms. Add these to the permission table.

## Facts from the code (the planner checked them; they matter)
- `MatchId` is `` `M${number}` ``, and `pairFirstRound` makes M1..Mn. `MATCH_IDS=['M1','M2']` only matters for the legacy env fixture (`TCG_DISCORD_M1/M2_CHANNEL_ID`, `discord/config.ts:43-54`). **Leave that legacy env mode alone**; the pool is for signup tournaments (`state.firstRound`).
- Only one round exists today, so `{round}` renders "Round 1".
- Public match rooms currently require `matchChannels` in three places: `runtime.ts:768-769`, `match-rooms.ts:86` (the reconciler constructor), and `assertPublicMatchRoomTargets` (`runtime.ts:344-353`, which also requires the `TCG Match ` prefix). All three must stop requiring it.
- The setup guards compare against an exact table list (`rehearsal/schema-tables.ts:47-58`). **New tables must be added to the optional-table list**, or every setup command breaks.
- `sameIdentityMap` and `sameSelection` must not include the pool or `matchRooms`, or active sessions show as "changed".
- The public-room reconciler returns early until every match is bound (`match-rooms.ts:136`). The pool must bind every match or throw.
- The demo has two sets of room IDs: `DEMO_MATCH_CHANNELS` in demo-runtime, and the DemoGuild voice channels. The demo publish step gives `roundRooms` random IDs. Unify them so the demo pool is the source.

## Data (migration `017_match_rooms.sql`, applied by `setupAdminToolsSchema` after 016; every table on the optional-table list)
```sql
tcg_match_room_settings(guild_id PK, version int>=1, template text 1..100, category_id text NULL, pending_category_name text NULL,
  baseline_channel_ids text[] NOT NULL DEFAULT '{}', baseline_captured_at_ms bigint NULL, updated_at_ms bigint)
tcg_match_room_categories(guild_id, category_id, range_from int, range_to int, origin text IN ('created','configured'),
  created_at_ms bigint, PRIMARY KEY (guild_id, category_id))
tcg_match_rooms(guild_id, channel_id, application_id, table_no int >=1, category_id text NULL, origin text IN ('created','adopted'),
  custom_name text NULL, applied_name text NULL, desired_name text NULL, original_name text NULL,
  rename_log bigint[] NOT NULL DEFAULT '{}' CHECK (cardinality(rename_log)<=4), next_rename_at_ms bigint NULL, rename_error text NULL,
  missing_since_ms bigint NULL, created_at_ms bigint, PRIMARY KEY (guild_id, channel_id), UNIQUE (guild_id, table_no))
tcg_match_room_transcripts(id uuid PK, guild_id, event_id, match_id, channel_id, channel_name text, started_at_ms bigint, archived_at_ms bigint,
  reason text IN ('reassigned','cleanup','manual'), message_count int, content_available boolean, messages jsonb NOT NULL,
  skipped_old int NOT NULL DEFAULT 0, hold boolean NOT NULL DEFAULT false, deleted_at_ms bigint NULL,
  CHECK (pg_column_size(messages) < 4000000))
```
- Each message in `messages` is `{id, authorId, authorName, createdAtMs, content|null, attachments:[{name,url,size}]}`. Attachments are stored as URL and metadata only; nothing is downloaded.
- Retention reuses the evidence retention value and sweep schedule.
- **If 017 hasn't run:** the runtime falls back to a memory store seeded from config and the session, and reports `storage: 'memory'` with a "run npm start" hint. Tournaments never break.
- **Bindings stay where they are:** the per-event binding stays in `identity_map.roundRooms`.

---

## W0: Foundation (one agent, lands first)
**Owns:**
- the new `packages/core/src/match-rooms-contract.ts` (plus its test) and the export in `packages/core/src/index.ts`
- the additive edits in `admin-contract.ts` and `admin-tools-contract.ts`
- the new `apps/server/src/admin-tools/match-rooms/service-port.ts`

```ts
export const MATCH_ROOM_TEMPLATE_TOKENS = ['match','n','table','round','event','game'] as const;
export const MATCH_ROOM_DEFAULT_TEMPLATE = '🎮 {match}';
export const MATCH_ROOM_TEMPLATE_PRESETS = ['🎮 {match}', '{table} · {round}', '⚔️ {round} · {match}'] as const;
export const MATCH_ROOM_LIMITS = { tablesPerCategory: 50, serverChannels: 500, nameLength: 100, eventNameLength: 40,
  renamesPerWindow: 2, renameWindowMs: 600_000 } as const;
export const MATCH_ROOM_RENAME_NOTICE = 'Queued — Discord allows 2 renames per 10 minutes.';
export interface MatchRoomNameContext { matchId: MatchId; table: number; round: number; eventName: string | null; gameLabel: string | null }
export function validateMatchRoomTemplate(t: string): string | null;   // known tokens only; must contain {match}|{n}|{table}; worst case ≤100 (code points and UTF-16)
export function renderMatchRoomName(t: string, c: MatchRoomNameContext): string;  // empty result -> `Match {n}`
export function sanitizeEventName(name: string | null): string;      // strip control/newlines, collapse spaces, ≤40 with …
export function validMatchRoomName(name: string): string | null;     // 1–100 readable chars
export function overflowCategoryName(gameLabel: string | null, from: number, to: number): string; // "One Piece 51–100", fallback "TCG"
export function categoryRangeForTable(table: number): { index: number; from: number; to: number }; // 1–50, 51–100, ...
export type MatchRoomRenameState = 'synced' | 'queued' | 'retrying' | 'failed';
export interface MatchRoomSettingsDto { version: number; template: string; categoryId: Snowflake|null; categoryName: string|null;
  pendingCategoryName: string|null; baselineChannelIds: Snowflake[]; baselineCapturedAtMs: number|null }
export interface SaveMatchRoomSettingsRequestDto { expectedVersion: number; template: string; categoryId: Snowflake|null;
  createCategory: string|null; baselineChannelIds: Snowflake[] }
export interface MatchRoomDto { channelId: Snowflake; table: number; categoryId: Snowflake|null; origin: 'created'|'adopted';
  name: string|null; missing: boolean; customName: string|null; templateName: string; pendingName: string|null;
  rename: { state: MatchRoomRenameState; nextAttemptAtMs: number|null; error: string|null };
  assignedMatch: MatchId|null; connected: MemberDto[]|null; recording: VoiceRoomStatus|null; removeBlockedReason: string|null }
export interface MatchRoomCategoryDto { categoryId: Snowflake; name: string|null; from: number; to: number; origin: 'created'|'configured'; missing: boolean }
export interface BaselineChannelDto { id: Snowflake; name: string; type: 'voice'|'stage'|'category'; inBaseline: boolean; botCreated: boolean }
export interface MatchRoomsDto { guildId: Snowflake; storage: 'postgres'|'memory'; canManageChannels: boolean; problem: string|null;
  activeEventId: string|null; eventName: string|null; gameLabel: string|null; round: number; freeChannelSlots: number|null;
  settings: MatchRoomSettingsDto; categories: MatchRoomCategoryDto[]; rooms: MatchRoomDto[]; baseline: BaselineChannelDto[] }
export interface CleanupPlanItemDto { channelId: Snowflake; name: string|null; kind: 'room'|'category';
  action: 'delete'|'restore'|'keep'|'skip'; reason: string; restoreName?: string|null }
export interface CleanupPlanDto { eventId: string|null; items: CleanupPlanItemDto[]; transcriptsToArchive: number; planToken: string }
export interface CleanupResultDto { deleted: Snowflake[]; restored: Snowflake[]; skipped: Array<{ channelId: Snowflake; reason: string }>; archived: number }
export interface MatchRoomTranscriptMessageDto { id: Snowflake; authorId: Snowflake; authorName: string|null; createdAtMs: number;
  content: string|null; attachments: Array<{ name: string; url: string; size: number|null }> }
export interface MatchRoomTranscriptDto { id: string; eventId: string; matchId: MatchId; channelId: Snowflake; channelName: string|null;
  startedAtMs: number|null; archivedAtMs: number; reason: 'reassigned'|'cleanup'|'manual'; messageCount: number;
  contentAvailable: boolean; skippedOld: number; hold: boolean; messages: MatchRoomTranscriptMessageDto[] }
export interface MatchRoomTranscriptSummaryDto extends Omit<MatchRoomTranscriptDto, 'messages'> {}
export interface SetupMatchRoomsDto { categoryId: Snowflake|null; createCategory: boolean }
export const MATCH_ROOMS_AUDIT_KINDS = ['match_rooms.settings','match_rooms.renamed','match_rooms.created','match_rooms.removed',
  'match_rooms.adopted','match_rooms.forgotten','match_rooms.cleanup','match_rooms.restored','match_rooms.transcript'] as const; // spread into ADMIN_TOOLS_AUDIT_KINDS
```

**Additive changes in `admin-contract.ts`:**
- `SetupSelectionDto.matchRooms?: SetupMatchRoomsDto`
- `SetupChannelDto.type` gets `'category'`
- `SetupCapabilityDto.slot` gets `'rooms'`
- `SetupFinishDto.rooms?: { problem: string|null }`

**`service-port.ts`:**
```ts
export interface MatchRoomService {
  describe(): Promise<MatchRoomsDto>;
  saveSettings(req: SaveMatchRoomSettingsRequestDto): Promise<MatchRoomsDto>;        // OpsConflictError on version; template change enqueues renames
  setCustomName(channelId: string, customName: string|null): Promise<MatchRoomDto>;   // enqueues; never awaits a Discord rename
  ensureTables(count: number): Promise<{ created: Snowflake[]; rooms: MatchRoomsDto }>;
  adopt(channelId: string): Promise<MatchRoomDto>;
  forget(channelId: string): Promise<void>;
  cleanupPlan(): Promise<CleanupPlanDto>;
  cleanupConfirm(planToken: string): Promise<CleanupResultDto>;   // refuses a stale token (plan changed) with RuleError
  transcripts(eventId: string, matchId?: MatchId): Promise<MatchRoomTranscriptSummaryDto[]>;
  transcript(id: string): Promise<MatchRoomTranscriptDto>;
  setTranscriptHold(id: string, hold: boolean): Promise<void>;
}
export interface MatchRoomSetupSink { applySetup(guildId: string, applicationId: string, input: SetupMatchRoomsDto): Promise<void> }
export function attachMatchRoomService(s: MatchRoomService | null): void;
export function currentMatchRoomService(): MatchRoomService | null;
```
Errors are `RuleError` (the routes map it to 409) or `OpsInputError` (400).

**Tests:** every template rule, the presets, `{stage}` refused, `overflowCategoryName` and `categoryRangeForTable`, and the audit kinds.

---

## A: Pool, provisioning, renames, categories, runtime and migration (server)
**Owns:**
- the new `apps/server/src/admin-tools/match-rooms/{store,port,pool,renames,categories,migrate,service}.ts` and their tests
- `database/migrations/017_match_rooms.sql`, `admin-tools/schema.ts`, `rehearsal/schema-tables.ts` (and its test)
- `discord/{runtime,match-rooms,sdk}.ts`; `controller.ts` and `session.ts` only if needed
- `admin/runtime/demo-runtime.ts`, `admin/demo.ts`, `admin-tools/demo-guild.ts`
- tests for all of the above, plus a 017 DB test that is written but **not run**

**What to build:**
- **Stores:** `pgMatchRoomStore()` plus `MemoryMatchRoomStore`, covering settings, categories and rooms. The transcripts table is D's.
- **`RoomRenameQueue`:**
  - Persisted `desired_name`, `rename_log`, `next_rename_at_ms` and `rename_error`.
  - Coalescing: when a send succeeds, `desired_name` is cleared only if it still holds the value that was sent.
  - Budget: 2 renames per 600,000 ms. When the window is full, the next attempt is the oldest entry + 10 minutes + 1 second.
  - One timer, armed for the earliest due room.
  - Sends with `rest.patch(Routes.channel(id), {body:{name}, reason})` on `matchRoomRenameRest(token)` from `sdk.ts`, which sets `rejectOnRateLimit: () => true`.
  - Outcomes: `RateLimitError` reschedules using `retryAfter`. `10003` marks the room missing. `50013` or `50001` marks it failed with an error and retries after 10 minutes.
  - Renames made in Discord: when `channelUpdate` reports a name that isn't the applied or desired one, set `custom_name` and append to the log.
- **`MatchRoomPool.provision(session, state)`** replaces the body of `provisionRound`. For each match, table k is the number in Mk:
  - If it's already bound and cached, skip it.
  - Otherwise pick in this order: the saved binding, then a frozen legacy `config.matchChannels[Mk]`, then pool table k (fetch it; a 10003 marks it missing), then create one.
  - **Creating:** use the category for k's range (`categoryRangeForTable`). Range 1–50 uses the configured category if one is set; otherwise, and for every other range, ensure a bot-created category named `overflowCategoryName(game, from, to)`. Check the server's free channel slots first and refuse clearly. Create the room **with its desired name and `roomPlan` overwrites** in a single call, so it needs no rename.
  - **Before binding a reused room to a new match:** call D's `archiveAndClear(room, previousBinding, 'reassigned')`. It's injected as `onReassign`; await it, but continue on failure and record a warning.
  - **Then:** backup and overwrites as today, `bindRoundRoom`, emit `matchRoomAssigned`.
  - **Renames happen only when a room is newly bound to this event.** Desired = `custom_name ?? render(...)`; enqueue it if it differs. A restart mid-round never renames anything.
- **`roomPlan`:** drop `ManageRoles` from `botAllow`. Stop requiring `matchChannels` in the three places listed above, and remove the `TCG Match ` prefix check.
- **`migrateLegacyRooms`** (runs at start, idempotent, only while the pool is empty):
  - `config.matchChannels` M1/M2 become tables 1 and 2 with `origin:'adopted'`. Save `original_name` and the overwrite backup. Per decision 4, **no custom name**, so they rename to the template at the next event.
  - The active session's `roundRooms` are adopted by ID.
  - Voice channels named exactly `TCG Match Mk · <appId>` become `created`.
- **Baseline capture:** at first start with 017, if `baseline_captured_at_ms` is null, store every voice channel, stage channel and category ID that isn't a pool room or pool category.
- **Runtime wiring:**
  - `provisionRound` calls `pool.provision`.
  - Reserved channel IDs and the permission monitor include the pool rooms and categories.
  - `channelUpdate` handles renames made in Discord.
  - The queue starts after login and stops on shutdown.
- **Service:** `liveMatchRoomService` and `demoMatchRoomService` implement `MatchRoomService`. Clean-up and transcripts are delegated to D's module.
- **Demo:** a memory pool seeded with DemoGuild `🎮 M1` and `🎮 M2`, plus a demo port that changes `demo.channels`. The demo rename transport enforces 2 per 10 minutes on the real clock and applies after about 1.5 s, so "queued" is visible. The demo runtime takes `roundRooms` from the same pool.

---

## D: Transcripts and clean-up (server)
**Owns:**
- the new `apps/server/src/admin-tools/match-rooms/{transcripts,cleanup}.ts` and their tests
- the transcript store, with pg and memory versions, using the 017 transcripts table. A owns the SQL file, and the table definition above is fixed.
- the retention hook: transcripts are included in the existing evidence retention sweep. Add the call where evidence retention runs; if that file is evidence-owned, add one small call and note it.

**Exports:**
```ts
export interface RoomChatPort { fetchMessages(channelId: string, sinceMs: number|null): Promise<{ messages: MatchRoomTranscriptMessageDto[]; contentAvailable: boolean }>;
  bulkDelete(channelId: string, ids: string[]): Promise<{ deleted: number; skippedOld: number }> }
export function archiveAndClear(deps: { chat: RoomChatPort; store: TranscriptStore; audit }, room: { channelId: string; name: string|null },
  binding: { eventId: string; matchId: MatchId; startedAtMs: number|null }, reason: 'reassigned'|'cleanup'|'manual'): Promise<{ transcriptId: string|null; warning: string|null }>;
export function buildCleanupPlan(input: { rooms; categories; baselineIds: string[]; activeEventId: string|null; occupancy; overwriteBackups }): CleanupPlanDto;
export function executeCleanup(deps, plan: CleanupPlanDto, token: string): Promise<CleanupResultDto>;
```

**Clean-up rules:**
- **Delete** only `origin:'created'` rooms and categories that aren't in the baseline.
- **Restore** adopted rooms: their `original_name` (through A's rename queue) and the overwrite backup.
- **Skip** anything occupied, and anything bound to a still-active event, with reasons.
- **Archive** each room's chat (reason `cleanup`) before deleting it. Delete a category only once it's empty.
- **Token:** `planToken` is a hash of the plan, and a changed plan refuses the confirm.
- **Audit:** `match_rooms.cleanup` and `match_rooms.restored`.

**Live `RoomChatPort`:** pages the voice channel's text chat with `before` up to the binding start. It reads the Message Content intent from the client options. Bulk delete only covers messages under 14 days old; older ones are counted as `skippedOld` and kept. **Demo port:** synthetic messages.

---

## B: Setup, routes, permissions, README (server)
**Owns:**
- `onboarding/{profile,service,discord,entry}.ts` and their tests
- the new `apps/server/src/admin-tools/match-rooms/routes.ts` (plus its test), and one line in `admin-tools/route-registry.ts`
- `permissions/{table,checker,setup}.ts` and `permissions.test.ts`
- `README.md` and the `.env.example` comment

**Routes** (GET needs `members.read`; the rest need `server.manage`; every change is audited; with no service attached, answer 503 "Rooms are available once the bot is connected"):
- `GET /api/v1/admin-tools/match-rooms`
- `PUT .../match-rooms/settings`
- `PATCH .../match-rooms/rooms/:channelId` with `{customName}`
- `DELETE .../match-rooms/rooms/:channelId` (forget)
- `POST .../match-rooms/ensure` with `{tables}`
- `POST .../match-rooms/adopt` with `{channelId}`
- `GET .../match-rooms/cleanup` returns `CleanupPlanDto`
- `POST .../match-rooms/cleanup` with `{planToken}` returns `CleanupResultDto`
- `GET .../match-rooms/transcripts?eventId=&matchId=`
- `GET .../match-rooms/transcripts/:id`
- `PATCH .../match-rooms/transcripts/:id` with `{hold}`

**Setup:**
- No M1/M2 requirement for new setups, and no `TCG Match` prefix rule.
- `matchRooms` category picker, with categories listed by `onboarding/discord.ts`.
- `sameSelection` ignores `matchRooms`. A legacy selection with `matchChannels` stays valid. Frozen sessions are unchanged.
- `finish()` calls `roomSettings.applySetup(...)` and reports `SetupFinishDto.rooms` without failing setup.
- A `'rooms'` readiness row.

**Permissions:** rewrite `tournament.roundRooms` (drop the UNCERTAIN note). Add:
- `tournament.roomCategory` (category scope: View Channel, Manage Channels, Manage Roles, Connect)
- `tournament.roomChat` (rooms: View Channel, Read Message History, Manage Messages; warning: "Room chat can't be archived or cleared.")
- The Message Content intent dependency, noted in the same style as tickets.

---

## C: Web
**Owns:**
- the new `apps/web/src/features/admin-tools/match-rooms/{MatchRoomsTab,TemplateEditor,RoomRow,CleanupDialog,BaselineCard,api}.tsx/ts` and their tests
- `admin-tools/registry.ts` (a new **Rooms** tab)
- `bots/{RoomGrid,BotsTab}.tsx` and their test (show room names)
- `channels/ChannelsTab.tsx` copy
- `setup/{SetupWizard,WhatsNext}.tsx` and `setup.test.tsx`
- `capabilities/capabilities.ts` and its test
- `bot-permissions` fixtures
- a new **"Room chat"** section in the match drawer: `shell/MatchDrawer.tsx` plus a new `shell/RoomChatPanel.tsx`
- the event export entry for transcripts, wherever event exports live in web

**Rooms tab:**
- **List:** a row per room, grouped by category (with its range): current name, pending name with the queued notice and next attempt time, template or custom name with inline rename and "Use template", the assigned match, who's connected (or "not available"), and recording state.
- **Settings card:** template editor with presets and a **live preview** (using the core renderer and the current event and game), and the category picker or "create category".
- **Actions:** Create missing rooms, Add an existing voice channel.
- **Free-slot meter:** "N of 500 server channels free".
- **Clean-up:** a prominent **"Clean up after tournament"** button opens `CleanupDialog`. It groups the preview into Will be deleted, Will be restored, Kept and Skipped (with reasons), shows "N room chats will be archived first", and has a danger-styled Confirm. A stale plan shows "The rooms changed; review again." After confirming, it shows a result summary.
- **Baseline card** (in the Rooms tab): every voice channel, stage channel and category, with checkboxes and "bot-created" badges. Explains "These are kept after every tournament. The bot only ever deletes channels it created."

**Setup wizard:**
- No M1/M2 pickers. A category picker plus "Create a 'TCG Live — Matches' category".
- A legacy selection shows "Your current rooms join the pool and get the room naming at the next event."
- A rooms readiness row.

**Match drawer "Room chat":** the transcript list for the match and a message viewer. Show "Message text needs the Message Content intent" when `contentAvailable` is false. Hold toggle.

Use the shared `EditorDialog`, the ui primitives and tokens, and named controls. C codes against the W0 types and mocked APIs.

---

## Tests (each stream adds its own)
- **A:**
  - Rename queue:
    - Three requests send one PATCH with the latest name.
    - A third rename inside 10 minutes waits for the oldest entry + 10 minutes.
    - A 429 reschedules using `retryAfter`.
    - A restart resumes from the stored log.
    - The clear-only-if-unchanged step works.
    - A missing room is marked missing; a forbidden one is marked failed.
  - Provisioning:
    - Mk lands on table k.
    - A second event reuses the rooms without creating or renaming (with the default template).
    - A missing room is created inside the category with its name, and no rename call.
    - Table 51 goes into "One Piece 51–100".
    - The server channel limit is refused clearly.
    - The legacy frozen `matchChannels` path behaves identically.
    - A restart mid-round renames nothing.
    - `onReassign` is called before rebinding.
  - `roomPlan` has no ManageRoles. The reconciler works without `matchChannels`, and non-prefixed names are accepted.
  - Migration: adopted rooms rename to the template at the next event; running it twice changes nothing; the original name and backup are saved.
  - Baseline capture.
  - A rename made in Discord becomes the custom name.
  - Demo: the queued state is visible.
  - The schema classifier ignores the 017 tables.
- **D:**
  - Archive pages the chat, keeps attachment metadata, honours `contentAvailable`, skips messages over 14 days old, and audits.
  - The clean-up plan:
    - deletes only created, non-baseline channels
    - never deletes adopted or baseline ones
    - restores adopted names and overwrites
    - skips occupied and active ones
  - A stale token is refused.
  - Archive runs before delete, and a category is deleted only once empty.
  - Retention covers transcripts, and hold keeps them.
- **B:**
  - Routes: capability gates, validation, audit, 503 with no service, version 409, cleanup token flow.
  - Setup: a new setup without `matchChannels` is valid; a legacy selection is still valid; a frozen session is unchanged; categories are listed; `finish` applies room settings and reports a failure without failing.
  - Permission targets.
- **C:**
  - Wizard: no pickers; the category picker; the legacy note.
  - Rooms tab: rows, rename with the queued notice, Use template, template validation and preview, presets, create and adopt, read-only without `server.manage`.
  - Clean-up dialog: groups, Confirm, the stale plan message, the result.
  - Baseline card.
  - Room chat panel, including the no-content note.
  - RoomGrid shows names, and the capabilities entry exists.

## Rules for every agent
- Match the existing style and each file's line endings. Comments only where the intent isn't obvious.
- `npm run typecheck:all` and `npm run test:all` must pass from the repo root, with no skipped or deleted tests. If a failure is clearly in another stream's in-progress files, note it and carry on.
- **Never run `npm run test:db`**, and never connect to any real database.
- **Don't commit.** If you're stopped and resumed, run `git diff` first.
- Push back in your report if something doesn't fit the code.
- Report: files changed, decisions, deviations, and test counts.
