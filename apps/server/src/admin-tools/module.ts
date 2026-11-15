// Types for admin-tools route modules. A feature agent writes one module in its own file and appends it to
// adminToolsRouteModules (route-registry.ts); routes.ts mounts every module under /api/v1/admin-tools/.
import type { Guild } from 'discord.js';
import type { AdminToolsSettingsDto, EventSnapshotDto, EventSummaryDto, OpsAuditEntryDto, OpsAuditKind } from '@tcg-live/core';
import type { TournamentMembers } from '../discord/features.js';
import type { OpsActor, OpsAuditStore } from '../ops/audit.js';
import type { OpsRoute } from '../ops/http.js';
import type { DemoGuild } from './demo-guild.js';
import type { AdminToolsSettingsStore } from './settings.js';

/** Live Discord access for routes. Absent in the demo. */
export interface AdminToolsDiscord {
  /** The configured guild; rejects with HttpError 503 while the bot is not connected. */
  guild(): Promise<Guild>;
  botUserId(): string | null;
}

export interface AdminToolsRouteDeps {
  /** The configured guild ID; throws HttpError 503 until Discord setup is finished. */
  guildId(): string;
  /** 'postgres' in the Discord runtime (use pg* stores), 'memory' in the demo and tests (use Memory* stores). */
  storage: 'postgres' | 'memory';
  audit: OpsAuditStore;
  settings: AdminToolsSettingsStore;
  /** Null in the demo: act on `demo` instead. */
  discord: AdminToolsDiscord | null;
  /** The demo's synthetic server (members, bans, roles, channels); null with a real Discord. */
  demo: DemoGuild | null;
  /** Channels the tournament owns: stickies and ticket panels must be refused there (400). */
  reservedChannelIds(): Promise<ReadonlySet<string>>;
  /** Roster / check-ins / seated players of an event (bulk roles). Null when the event is unknown. */
  tournamentMembers(eventId: string): Promise<TournamentMembers | null>;
  /** Session-backed events, newest first; [] when the runtime has none or fails. Optional for hand-built deps. */
  listEvents?(): Promise<EventSummaryDto[]>;
  /** An event snapshot, or null when unknown. Optional for hand-built deps. */
  snapshot?(eventId: string): Promise<EventSnapshotDto | null>;
  /** Saved settings for the configured guild. */
  currentSettings(): Promise<AdminToolsSettingsDto>;
  /** Appends a tcg_ops_audit row for the configured guild; the actor defaults to the local admin. */
  recordAudit(kind: OpsAuditKind, payload: Record<string, unknown>, actor?: OpsActor): Promise<OpsAuditEntryDto>;
  /** After a committed change: running Discord features hear { type: 'adminToolsChanged', area, id }. Never throws. */
  notify(area: string, id?: string | null): void;
  /** Maps store errors (OpsInputError 400, OpsNotFoundError 404, OpsConflictError 409, database down 503). */
  guarded<T>(run: () => Promise<T>): Promise<T>;
  now(): number;
}

export interface AdminToolsRouteModule {
  /** Short area name, also the `area` of adminToolsChanged events (for example 'members', 'stickies'). */
  name: string;
  /** Called once per mount. Every pattern must start with ^\/api\/v1\/admin-tools\/. */
  routes(deps: AdminToolsRouteDeps): OpsRoute[];
}
