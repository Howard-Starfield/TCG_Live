# Brief: TCG Organizer and TCG Judge roles, and the organizer can play

Branch: `feat/tournament-roles`. This is planned work by an Opus planner, with decisions by the user. Agents work with **disjoint file ownership**: never edit a file you don't own. If you need something across a boundary, use only the interfaces here.

## Decisions (final)
- Two bot-managed Discord roles. **TCG Organizer** can do every staff action. **TCG Judge** can do rulings only: resolve, correct, judgeClose, judgeResume, checkin-for, evidence submit, and **evidence reply**. Judges can never publish, run signup open/close/reopen/add/remove, delay or start, end, retire or delete the tournament, change settings, moderate, or run refresh.
- **Server owner** always counts as Organizer.
- **The old organizer Discord ID (`adminId`) no longer counts as staff**, not even as a fallback. It stays in config and `identity_map` only for its other uses:
  - frozen setup identity (`sameIdentityMap`)
  - contact mention
  - room access overwrite
  - the identity behind the dashboard for the conflict rule
- Legacy `cases.staffRoleIds` count as **Judge**.
- **The organizer can play.** Being staff never bars joining signup. **Conflict rule:** any staff member seated in a match can't rule on *that* match (resolve, correct, judgeResume, judgeClose, evidence reply, evidence hold/delete). That includes the dashboard when `identity_map.adminId` is seated in it: those actions are blocked there, with an explanation. If no other staff member can be confirmed after signup closes, warn about it.
- **`/tcg-staff`: remove its default member permission** so everyone sees it, since the bot enforces who can run it. `/tcg-admin` keeps Manage Server.
- **Add `/tcg-staff judge-close`** (match, note) **and `/tcg-staff evidence-reply`**:
  - Options: match, text, and `staff-only` (boolean, default false).
  - It reuses the existing evidence replies service: `apps/server/src/evidence/replies.ts` plus the store, with the same Discord delivery, nonce, audit and mentions limited to seated players.
  - It's subject to the conflict rule.
- **Onboarding** creates both roles with no permissions (`0n`), placed directly under the bot's top role, and assigns TCG Organizer to the organizer chosen in setup (default: the server owner). It adopts roles by **stored ID only**, never by name. Role failures don't fail setup; they're reported instead.
- **Existing installs** (since the ID fallback is gone):
  - Roles are never auto-created at runtime.
  - The Roles card and the setup wizard prominently show **"Create TCG roles"** with the explanation "Until the roles exist, only the server owner and this dashboard act as organizer in Discord."
  - The bot-permission banner also flags missing roles.

## Model
- **Role IDs** live in the setup profile (`data/discord-setup.json`) as `roles: { guildId, organizerRoleId, judgeRoleId }`, behind a `TournamentRoleStore` interface. Keyed by guild: a different guild gets nulls.
- **Audit:** new actor ids `organizer:<discordId>` and `judge:<discordId>`. Dashboard, timers and the scheduler stay `admin:fixture`.
  - **Migration `016_staff_actor_snapshot.sql`:**
    ```sql
    ALTER TABLE public.tcg_rehearsal_audit
      ADD COLUMN IF NOT EXISTS actor_snapshot jsonb
      CHECK (actor_snapshot IS NULL OR (jsonb_typeof(actor_snapshot) = 'object' AND pg_column_size(actor_snapshot) < 1024))
    ```
    Applied by `setupAdminToolsSchema` after 014.
  - Snapshot shape: `{v:1,userId,username,displayName,role,via,roleName}`.
    - Strings are trimmed, have control characters stripped, and are capped at 100 characters.
    - The snapshot is written for every Discord principal.
    - It is excluded from the command hash.
  - The store detects the column (it caches only "yes"), so commands still work before setup runs.
- **Who is staff (pure `resolveStaff`):** checked in this order.
  1. Server owner → organizer (via `owner`).
  2. Organizer role → organizer (via `role`).
  3. Judge role → judge (via `role`).
  4. Legacy staff role → judge (via `legacy-staff-role`).
  5. Otherwise null. There is **no `organizer-id` source**.
  - If the sources can't be read, only the owner counts.
- **Actor algorithm** (`runPrincipalCommand` in `rehearsal/store.ts`):
  - **Dashboard, timer or scheduler:** act as `ADMIN`.
  - **Discord with `message` set** (card button or form): act as the member.
    - signupJoin/withdraw → `member:<id>`
    - seated → `player:<seat>`
    - otherwise refused
    - The old "principal is adminId, so admin" branch is removed.
  - **Discord slash command:** requires `context.actor`, which the controller sets after `resolveStaff` and `staffMay`. The actor becomes `${role}:${principalId}`. With no actor, refuse with `STAFF_DENIED`.
  - **Then the conflict check:** pure `rulingConflict(state, players, staffMemberId, command)` from `domain.ts`. It runs before the prior-result replay lookup and throws `StaffConflictError extends RuleError`:
    - "You are playing in M2, so another organizer or judge must rule on it."
    - The dashboard version adds: "Add a TCG Judge in Admin tools > Settings > Roles."
  - **Then the domain** checks the role again: `requireOrganizer`, `requireJudge`, or `requireSystem` (`clockCheck` only `ADMIN`).

### Capability table
| Action | Organizer | Judge | Conflict rule |
|---|---|---|---|
| publish, signup-close/reopen/remove/add, refresh | yes | no | |
| checkin-for | yes | yes | no |
| resolve, correct, judge-resume, judge-close | yes | yes | yes |
| evidence submit (when not seated; seated members submit as a player) | yes | yes | |
| evidence-reply | yes | yes | yes |
| /tcg-admin status and moderation | yes, plus Discord permission holders as today | no | the existing seated rule now includes organizers |
| dashboard-only items (delayStart, end, retire, delete, templates, settings, Roles card, evidence hold/delete) | dashboard (local admin) | no | rulings and hold/delete blocked on the operator's own match |
| clockCheck | system only | | |

---

## W0: Foundation (one agent, lands first; the others start after it reports)
**Owns:**
- the new `packages/core/src/staff-contract.ts` (exported from `packages/core/src/index.ts`)
- the additive changes in `admin-contract.ts`, `moderation-contract.ts` and `admin-tools-contract.ts`
- a rewrite of `apps/server/src/discord/staff.ts`, plus tests for both

**`staff-contract.ts`:**
```ts
export const TOURNAMENT_ROLE_KINDS = ['organizer','judge'] as const; export type TournamentRoleKind = typeof TOURNAMENT_ROLE_KINDS[number];
export const TOURNAMENT_ROLE_DEFAULTS: Readonly<Record<TournamentRoleKind,{name:string;color:number}>>; // 'TCG Organizer' 0xE67E22, 'TCG Judge' 0x3498DB
export const DISCORD_ROLE_COLOR_PRESETS: readonly number[]; // Discord's 20 role-colour swatches
export interface TournamentRoleIdsDto { guildId: Snowflake; organizerRoleId: Snowflake|null; judgeRoleId: Snowflake|null }
export type TournamentRoleProblem = 'not-created'|'missing'|'above-bot'|'managed'|'elevated'|'no-manage-roles';
export interface TournamentRoleMemberDto { id: Snowflake; displayName: string|null; avatarUrl: string|null }
export interface TournamentRoleDto { kind: TournamentRoleKind; roleId: Snowflake|null; name: string|null; color: number|null; position: number|null;
  problem: TournamentRoleProblem|null; problemText: string|null; members: TournamentRoleMemberDto[]; membersComplete: boolean }
export interface TournamentRolesDto { guildId: Snowflake; ownerId: Snowflake|null; canManageRoles: boolean;
  botTopRole: {id: Snowflake; name: string; position: number}|null; roles: TournamentRoleDto[]; legacyStaffRoleIds: Snowflake[] }
export interface TournamentRoleEditDto { name?: string; color?: number }  // name 1-100 chars; color 0..0xFFFFFF
export interface TournamentRolesEnsureResultDto { organizer: 'created'|'adopted'|'failed'; judge: 'created'|'adopted'|'failed'; assigned: Snowflake|null; problem: string|null }
export const STAFF_ACTIONS = ['publish','delayStart','signupClose','signupReopen','signupRemove','signupAdd','refresh','checkinFor',
  'resolve','correct','judgeResume','judgeClose','evidenceSubmit','evidenceReply','moderation'] as const; export type StaffAction = typeof STAFF_ACTIONS[number];
export const RULING_ACTIONS: ReadonlySet<StaffAction>; // resolve, correct, judgeResume, judgeClose, evidenceReply
export function staffMay(role: TournamentRoleKind, action: StaffAction): boolean;
```

**Additive changes in the existing contracts:**
- `admin-contract.ts`:
  - `StaffActorDto { memberId; role: TournamentRoleKind|null; via; name: string|null; username: string|null; roleName: string|null }`
  - `ActorDto` admin variant gains `staff?: StaffActorDto`
  - `MatchDto.staffConflict?: true`
  - `AdminCommandResultDto.staffWarning?: string|null`
  - `SetupFinishDto.roles?: TournamentRolesEnsureResultDto`
- Ops audit kinds (both contracts that list them): `tournament_roles.created`, `tournament_roles.updated`, `tournament_roles.member_added`, `tournament_roles.member_removed`.

**`discord/staff.ts`:**
```ts
export type StaffVia = 'owner'|'role'|'legacy-staff-role';
export interface StaffSources { roles: TournamentRoleIdsDto|null; legacyStaffRoleIds: readonly string[] }
export interface StaffSubject { userId: string; roleIds: readonly string[]; ownerId: string|null }
export interface ResolvedStaff { role: TournamentRoleKind; via: StaffVia }
export function resolveStaff(subject: StaffSubject, sources: StaffSources): ResolvedStaff|null;
export function memberRoleIds(member: unknown): string[];   // unchanged
export const STAFF_DENIED: string; export function judgeDenied(action: StaffAction): string; export function rulingConflictText(matchId: string, dashboard: boolean): string;
export type StaffCoverage = (seatedIds: readonly string[]) => Promise<{ otherStaff: number; complete: boolean }>;
```
Keep `isTournamentStaff` as a deprecated wrapper (`resolveStaff(...) !== null`) so current callers compile until A removes them.

**Tests:**
- `resolveStaff` covers every source, the owner while seated, a role that is both legacy and Judge, and unreadable sources.
- `staffMay` covers the whole capability table.

---

## A: Authorization, actor model, audit, and the new slash commands (server)
**Owns:**
- `apps/server/src/rehearsal/{domain,store}.ts`
- `apps/server/src/discord/{controller,runtime,session,match-rooms,features,feature-testing}.ts`, and `staff.ts` after W0 (only to remove the wrapper at the end)
- `apps/server/src/evidence/discord-submit.ts`, and `evidence/routes.ts` (the conflict for dashboard hold, delete and reply only)
- `apps/server/src/admin-tools/members/discord-feature.ts`, `admin-tools/lfg/feature.ts`
- `apps/server/src/admin/commands.ts`, `admin/runtime/{mappers,queries,demo-runtime,testing}.ts`
- `apps/server/src/admin-tools/schema.ts` (apply 016), `database/migrations/016_staff_actor_snapshot.sql`
- every server test touched by the above: domain, store-principal, store.db, controller*, next-wave, signup, match-rooms, session.db, mappers, commands*, demo-commands, discord-commands, controller-notify, queries.db, fixtures, discord-submit, features, runtime, permissions? (no, that's B)

**Key changes:**
- In `domain.ts`, split `requireAdmin` into `requireOrganizer` / `requireJudge` / `requireSystem`. Drop the `roster.includes(adminId)` refusal in signupClose, but keep the `adminId` field. Fix the "nonadmin" copy. Export `rulingConflict` and `StaffConflictError`.
- In `store.ts`:
  - Use the actor algorithm above, with `DiscordCommandContext.actor?: { role; via; username; displayName; roleName }` and `snapshot?: {username, displayName}`.
  - Remove "Signup admin cannot play."
  - Write `actor_snapshot` when the column exists.
- `session.ts:69`: remove the throw when the roster contains adminId. This **must** go, or an organizer who joins breaks the cards.
- `match-rooms.ts:177`: move a seated organizer into their room. Keep the organizer overwrite.
- `controller.ts`:
  - Add `setStaffSources(() => Promise<StaffSources>)`, `setStaffCoverage(StaffCoverage)`, and `staffRole(userId, roleIds, ownerId)`.
  - Gate every staff subcommand with `staffMay`, and return `judgeDenied(action)`.
  - Remove the "staff who play cannot run staff commands" rule and "Signup admin cannot play".
  - Add the `judge-close` and `evidence-reply` subcommands with their autocomplete. Evidence-reply calls the evidence replies service; extend `DiscordFeatureContext` or the controller deps with a narrow `sendEvidenceReply(...)` port wired in `runtime.ts`.
  - After a committed signupClose, add `staffWarning` from `staffCoverage(rosterIds)` ("could not confirm" when incomplete).
- `runtime.ts`:
  - Remove `setDefaultMemberPermissions(ManageGuild)` from `/tcg-staff` only. Add the two subcommands to `STAFF_SUBCOMMANDS`.
  - `adapt()` passes `username`, `displayName` and `ownerId` (`interaction.guild?.ownerId`).
  - Wire `setStaffSources` with B's `profileTournamentRoleStore().get(guildId)` plus `cases.staffRoleIds`.
  - Wire `staffCoverage` with B's `tournamentRoleHolders`.
  - Replace the evidence-modal hack (`adminId: staff ? user : config.adminId`) with `controller.staffRole()`.
- `features.ts`: add `staffRoleOf({userId, roleIds}) => Promise<ResolvedStaff|null>` and fake it in `feature-testing.ts`. Use it in `discord-submit.ts`, `members/discord-feature.ts` (moderation is Organizer only, plus Discord permission holders as today; remove the adminId exemption; the owner is exempt only from the hierarchy check) and `lfg/feature.ts`.
- `admin/commands.ts`: remove the "organizer cannot play" refusal.
- `mappers.ts`:
  - `mapActor` maps `organizer:` and `judge:`, plus legacy `admin:fixture` rows that have a Discord principal, to `{kind:'admin', staff}`.
  - `matchAdminActions` returns `[]` and sets `staffConflict: true` when adminId is seated.
  - `eventAdminActions` drops the roster check.
- `queries.ts`: add `AUDIT_COLUMNS` `to_jsonb(a.*)->'actor_snapshot' AS actor_snapshot`.
- Demo: optionally seat the organizer in one match to show the conflict state.

**Until B lands:** import B's `profileTournamentRoleStore` and `tournamentRoleHolders` from `admin-tools/tournament-roles/{store,port}.ts`. If they don't exist yet, code against the signatures in section B and wire them last.

**Tests:** see "Tests" below.

---

## B: Discord role management, setup and admin routes (server)
**Owns:**
- the new `apps/server/src/admin-tools/tournament-roles/{store,port,service,routes}.ts` and their tests
- `admin-tools/route-registry.ts` (one line), `admin-tools/demo-guild.ts` (seed the two roles plus members)
- `onboarding/{profile,service,discord}.ts` and their tests
- `permissions/{table,checker}.ts` and their tests
- `README.md`: the permissions table, the staff and roles section, the `/tcg-staff` visibility change, and the new subcommands

**Exports:**
```ts
// store.ts
export interface TournamentRoleStore { get(guildId: string): Promise<TournamentRoleIdsDto>; set(value: TournamentRoleIdsDto): Promise<void> }
export function profileTournamentRoleStore(profile?: SetupProfileStore): TournamentRoleStore;  // other guild -> nulls
export class MemoryTournamentRoleStore implements TournamentRoleStore {}
// port.ts (live Guild + DemoGuild implementations)
export interface PortRoleDetail { id; name; color; position; managed: boolean; permissions: bigint }
export interface TournamentRolesPort { describe(): Promise<{ownerId; canManageRoles; botTop: {id;name;position}; roles: PortRoleDetail[]}>;
  create(kind: TournamentRoleKind): Promise<PortRoleDetail>;  // permissions 0n, then position = botTop.position - 1
  edit(roleId: string, edit: TournamentRoleEditDto): Promise<PortRoleDetail>; addMember(userId, roleId, reason): Promise<void>; removeMember(userId, roleId, reason): Promise<void> }
export function tournamentRoleHolders(guild: Guild, roleIds: readonly string[], intentOn: boolean): Promise<{ ids: string[]; complete: boolean }>;
// service.ts
export function ensureTournamentRoles(port, store, guildId, organizerId: string, actor: OpsActor): Promise<TournamentRolesEnsureResultDto>; // adopt by stored ID only; refuse 'elevated'
export function describeTournamentRoles(port, store, guildId, legacy: string[]): Promise<TournamentRolesDto>;
```

**Routes** (GET needs `members.read`; the rest need `server.manage`; every change is audited with the new kinds):
- `GET /api/v1/admin-tools/tournament-roles`
- `POST /api/v1/admin-tools/tournament-roles/ensure`, body `{ organizerId? }`; defaults to the setup organizer, else the owner
- `PATCH /api/v1/admin-tools/tournament-roles/:kind` (`TournamentRoleEditDto`)
- `PUT | DELETE /api/v1/admin-tools/tournament-roles/:kind/members/:userId`

**Rules:**
- Refuse to assign when the role is `managed`, `above-bot` or `elevated`. Reuse the existing `roleProblem` helper in admin-tools roles, since the bot never grants staff-level permissions.
- `problemText` explains the fix, for example "Move the TCG Live role above TCG Judge in Server Settings > Roles."
- Member lists without the Server Members intent: use the cache plus the roster plus the owner plus per-id fetches, and set `membersComplete: false`.

**Setup:**
- `profile.ts` gets an optional `roles` key (omitted on save means kept).
- `SetupDiscovery.ensureTournamentRoles` is implemented in `onboarding/discord.ts`.
- `finish()` calls it after the check passes and before prepare, with `selection.adminId`, and returns `roles` in `SetupFinishDto`. It never fails setup.

**Permissions:** add the `'Tournament roles'` group:
- `tournamentRoles.manage`: guild scope, ManageRoles, warning
- `tournamentRoles.hierarchy`: role-hierarchy, targeting the stored role IDs (`PermissionConfig.tournamentRoles`)
- a "roles not created yet" warning

**Demo:** the demo guild seeds both roles, with the demo organizer holding Organizer and one member holding Judge, so the card renders.

---

## C: Web
**Owns:**
- the new `apps/web/src/features/admin-tools/tournament-roles/{TournamentRolesCard.tsx,api.ts,*.test.tsx}`
- `features/admin-tools/SettingsTab.tsx`
- `features/setup/{SetupWizard,WhatsNext}.tsx` and `setup.test.tsx`
- `features/capabilities/capabilities.ts` (+ test)
- `features/commands/grammar.ts` (+ test)
- `data/format.ts`, `features/console/ActivityStream.tsx`, `features/lists/AuditTab.tsx`
- the match-actions display of `staffConflict` and `staffWarning`: `features/commands/actions.tsx` and `dialogs.tsx` only for that display, plus `shell/MatchDrawer.tsx` and `shell/JudgeRequestCard.tsx` (the drawer must show the conflict reason)
- `features/bot-permissions/*` fixtures and copy

**The Roles card** (Admin tools > Settings, the first card):
- one row per role: name (inline rename), a colour picker with the 20 preset swatches plus a custom hex field with validation, the member list with avatars, and Add member (reuse the admin-tools member search) and Remove
- problem explanations
- "List may be incomplete" when `membersComplete` is false
- a prominent **"Create TCG roles"** call to action while the roles don't exist, with the decided explanation
- the legacy staff-roles note: "count as TCG Judge; give TCG Organizer to anyone who needs more"

**Other web copy and display:**
- The `/tcg-staff` visibility change is explained in one line.
- Setup wizard: the organizer field says it "gets the TCG Organizer role and may also play". Step 3 shows the roles result.
- Composer: signup-add of the organizer is allowed.
- Audit tab and activity stream: "Resolved by @name (TCG Judge)", falling back to the member's display name.
- Drawer and console: rulings blocked by the conflict show "You're playing in this match, so a TCG Judge must rule on it."

C codes against the W0 types plus a mocked API, so it doesn't wait for B.

---

## Tests (each stream adds its own)
- **A:**
  - Domain: a judge is refused publish and signup actions and accepted for rulings; clockCheck only works for ADMIN; the organizer is not refused at signupClose.
  - Store:
    - A seated organizer's card buttons act as `player:`.
    - A staff slash command acts as `organizer:` or `judge:`.
    - A conflict is refused from Discord and from the dashboard, but allowed on another match.
    - A replay after a conflict is still refused.
    - The snapshot is written once 016 has run and skipped before it.
  - Controller:
    - `judgeDenied` for every Organizer-only subcommand.
    - judge-close and evidence-reply work end to end, and evidence-reply hits the conflict rule.
    - `/tcg-staff` has no default member permission.
  - `resolvePlayers` accepts the organizer.
  - Mappers: legacy rows map to `staff` with role null; `staffConflict` hides the actions.
  - Moderation is refused for a judge.
  - Migration 016 is idempotent: write the DB test, but **don't run it**.
- **B:**
  - Ensure creates both roles with permissions 0 under the bot's top role; a rerun adopts by ID; a rerun with a same-named role whose ID wasn't stored creates a new role.
  - A missing role is reported, then recreated.
  - Assigning refuses elevated, above-bot and managed roles.
  - Routes check capabilities and audit.
  - The profile round-trips `roles`.
  - Setup `finish()` succeeds without Manage Roles and reports it.
  - The permission entries target the stored role IDs.
- **C:**
  - Roles card: rename, preset and custom hex colour (invalid hex rejected), add and remove members, problem text, the incomplete notice, and Create TCG roles.
  - The setup copy and the step 3 result.
  - The composer allows the organizer.
  - The audit label "(TCG Judge)".
  - The conflict message in the drawer.

## Rules for every agent
- Match the existing style and each file's line endings. Comments only where the intent isn't obvious.
- `npm run typecheck:all` and `npm run test:all` must pass from the repo root, with no skipped or deleted tests. If a failure is clearly in another stream's in-progress files, note it and carry on.
- **Never run `npm run test:db`**, and never connect to any real database. The orchestrator runs DB tests on a throwaway cluster.
- **Don't commit.** If you're stopped and resumed, run `git diff` first.
- Push back in your report if something here doesn't fit the code.
- Report: files changed, decisions, deviations, and test counts.
