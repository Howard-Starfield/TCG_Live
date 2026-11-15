// Admin tools HTTP routes: the foundation (settings with optimistic version, status, guild metadata) plus
// every module in adminToolsRouteModules. All mutations are audited in tcg_ops_audit.
import { ChannelType, type Guild } from 'discord.js';
import type { AdminToolsSettingsConflictDto, AdminToolsSettingsDto, EventSnapshotDto, EventSummaryDto, GuildChannelDto, GuildMetaDto,
  Seat } from '@tcg-live/core';
import { readJsonBody, strictObject } from '../admin/http/body.js';
import { HttpError, sendJson } from '../admin/http/respond.js';
import type { TournamentMembers } from '../discord/features.js';
import { LOCAL_ADMIN, type OpsAuditStore } from '../ops/audit.js';
import { mapOpsError } from '../ops/errors.js';
import { badRequest, type OpsRoute } from '../ops/http.js';
import type { DemoGuild } from './demo-guild.js';
import type { AdminToolsDiscord, AdminToolsRouteDeps, AdminToolsRouteModule } from './module.js';
import { adminToolsRouteModules } from './route-registry.js';
import { isElevatedPermissions } from './roles/guild-port.js';
import { ADMIN_TOOLS_SETUP_HINT } from './schema.js';
import { AdminToolsVersionConflictError, adminToolsBody, parseAdminToolsSettings, reservedChannelProblem,
  type AdminToolsSettingsStore } from './settings.js';
import type { AdminToolsRuntimeState } from './status.js';

export const ADMIN_TOOLS_UNAVAILABLE = `Admin tools storage is unavailable. Check PostgreSQL. ${ADMIN_TOOLS_SETUP_HINT}`;
export const ADMIN_TOOLS_ROUTE_PREFIX = /^\^\\\/api\\\/v1\\\/admin-tools\\\//;

export interface AdminToolsRouteOptions {
  settings: AdminToolsSettingsStore;
  audit: OpsAuditStore;
  storage: 'postgres' | 'memory';
  /** The configured Discord server; null answers 503 until setup finishes. */
  guildId(): string | null;
  status: AdminToolsRuntimeState;
  /** Live Discord access (Discord runtime only). */
  discord?: AdminToolsDiscord;
  /** Synthetic server for the demo. */
  demo?: DemoGuild;
  /** Channels the tournament owns. Defaults to none (demo: the dataset's reserved channels). */
  reservedChannelIds?(): Promise<readonly string[]>;
  /** Event snapshots for tournamentMembers(); the admin handler supplies its runtime. */
  snapshot?(eventId: string): Promise<EventSnapshotDto>;
  /** Session-backed events, newest first (member tournament history); the admin handler supplies its runtime. */
  listEvents?(): Promise<EventSummaryDto[]>;
  /** After a committed settings save; running Discord features reload from here. Never throws into the route. */
  onSettingsSaved?(settings: AdminToolsSettingsDto): void;
  /** After a module's committed change (deps.notify). */
  onChanged?(area: string, id: string | null): void;
  /** Defaults to adminToolsRouteModules; tests pass their own. */
  modules?: readonly AdminToolsRouteModule[];
  now?(): number;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { return mapOpsError(error, ADMIN_TOOLS_UNAVAILABLE); }
}

/** Roster, check-ins and seated players from an event snapshot (both runtimes expose snapshots). */
export function membersFromSnapshot(snapshot: EventSnapshotDto): TournamentMembers {
  const seatUser = (seat: Seat) => snapshot.seats[seat] ?? null;
  const players = [...new Set(snapshot.matches.flatMap(match => match.seats.map(seatUser)).filter((id): id is string => !!id))];
  const seated = Object.values(snapshot.seats).filter((id): id is string => !!id);
  return {
    eventId: snapshot.eventId,
    roster: [...new Set(snapshot.signup?.roster ?? seated)],
    checkedIn: [...new Set(snapshot.checkins.map(seatUser).filter((id): id is string => !!id))],
    players
  };
}

const CHANNEL_TYPES: Partial<Record<ChannelType, GuildChannelDto['type']>> = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildForum]: 'forum', [ChannelType.GuildStageVoice]: 'stage'
};

/** Roles, channels and emojis of a live guild, with the tournament's channels marked reserved. */
export async function liveGuildMeta(guild: Guild, reserved: ReadonlySet<string>): Promise<GuildMetaDto> {
  const [roles, channels, emojis, me] = await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch(),
    guild.members.fetchMe()]);
  const top = me.roles.highest.position;
  return {
    guildId: guild.id, name: guild.name, memberCount: guild.memberCount ?? null,
    roles: [...roles.values()].map(role => ({ id: role.id, name: role.name, color: role.color, position: role.position,
      managed: role.managed, aboveBot: role.position >= top, elevated: isElevatedPermissions(role.permissions.bitfield) })).sort((a, b) => b.position - a.position),
    channels: [...channels.values()].flatMap(channel => {
      const type = channel ? CHANNEL_TYPES[channel.type] : undefined;
      return channel && type ? [{ id: channel.id, name: channel.name, type, parentId: channel.parentId,
        position: 'position' in channel ? channel.position : 0, reserved: reserved.has(channel.id) }] : [];
    }),
    emojis: [...emojis.values()].map(emoji => ({ id: emoji.id, name: emoji.name ?? 'emoji', animated: emoji.animated ?? false }))
  };
}

function demoGuildMeta(demo: DemoGuild, reserved: ReadonlySet<string>): GuildMetaDto {
  return { guildId: demo.id, name: demo.name, memberCount: demo.members.length,
    roles: structuredClone(demo.roles).sort((a, b) => b.position - a.position),
    channels: demo.channels.map(channel => ({ ...channel, reserved: channel.reserved || reserved.has(channel.id) })),
    emojis: structuredClone(demo.emojis) };
}

export function adminToolsRoutes(options: AdminToolsRouteOptions): OpsRoute[] {
  const now = options.now ?? Date.now;
  const guildId = (): string => {
    const id = options.guildId();
    if (!id) throw new HttpError(503, 'unavailable', 'Finish Discord setup before using the admin tools.');
    return id;
  };
  const reservedChannelIds = async (): Promise<ReadonlySet<string>> => {
    const listed = await options.reservedChannelIds?.().catch(() => []) ?? [];
    const demo = options.demo?.channels.filter(channel => channel.reserved).map(channel => channel.id) ?? [];
    return new Set([...listed, ...demo]);
  };
  const safely = (callback: () => void) => { try { callback(); } catch { /* Listeners never fail a request. */ } };
  const deps: AdminToolsRouteDeps = {
    guildId, storage: options.storage, audit: options.audit, settings: options.settings,
    discord: options.discord ?? null, demo: options.demo ?? null, reservedChannelIds,
    tournamentMembers: async eventId => {
      if (!options.snapshot) return null;
      try { return membersFromSnapshot(await options.snapshot(eventId)); } catch { return null; }
    },
    listEvents: async () => { try { return await options.listEvents?.() ?? []; } catch { return []; } },
    snapshot: async eventId => { if (!options.snapshot) return null; try { return await options.snapshot(eventId); } catch { return null; } },
    currentSettings: () => guarded(() => options.settings.get(guildId())),
    recordAudit: (kind, payload, actor = LOCAL_ADMIN) => guarded(() => options.audit.append({ kind, actor, guildId: guildId(), payload })),
    notify: (area, id = null) => safely(() => options.onChanged?.(area, id)),
    guarded, now
  };

  const foundation: OpsRoute[] = [
    { pattern: /^\/api\/v1\/admin-tools\/settings$/, methods: {
      GET: { access: 'members.read', run: async ({ response }) => {
        const id = guildId();
        sendJson(response, 200, await guarded(() => options.settings.get(id)));
      } },
      PUT: { access: 'server.manage', run: async ({ request, response }) => {
        const id = guildId();
        const { expectedVersion, settings } = strictObject(await readJsonBody(request), ['expectedVersion', 'settings']);
        if (typeof expectedVersion !== 'number') throw badRequest('expectedVersion must be the version you loaded.');
        const parsed = await guarded(async () => parseAdminToolsSettings(settings));
        const clash = reservedChannelProblem(parsed, await reservedChannelIds());
        if (clash) throw badRequest(clash);
        let saved: AdminToolsSettingsDto;
        try { saved = await options.settings.put(id, expectedVersion, settings, LOCAL_ADMIN); }
        catch (error) {
          if (error instanceof AdminToolsVersionConflictError) {
            const body: AdminToolsSettingsConflictDto = { error: { code: 'conflict', message: error.message }, current: error.current };
            sendJson(response, 409, body);
            return;
          }
          return mapOpsError(error, ADMIN_TOOLS_UNAVAILABLE);
        }
        safely(() => options.onSettingsSaved?.(saved));
        sendJson(response, 200, saved);
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/status$/, methods: {
      GET: { access: 'members.read', run: async ({ response }) => {
        const id = guildId();
        const settings = await guarded(() => options.settings.get(id));
        sendJson(response, 200, options.status.describe(adminToolsBody(settings)));
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/guild$/, methods: {
      GET: { access: 'members.read', run: async ({ response }) => {
        guildId();
        const reserved = await reservedChannelIds();
        if (options.demo) { sendJson(response, 200, demoGuildMeta(options.demo, reserved)); return; }
        if (!options.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
        const guild = await options.discord.guild();
        let meta: GuildMetaDto;
        try { meta = await liveGuildMeta(guild, reserved); }
        catch { throw new HttpError(503, 'unavailable', 'Discord did not answer. Try again in a moment.'); }
        sendJson(response, 200, meta);
      } }
    } }
  ];

  const modules = options.modules ?? adminToolsRouteModules;
  const names = new Set<string>();
  const extra = modules.flatMap(module => {
    if (names.has(module.name)) throw new Error(`Duplicate admin tools route module ${module.name}.`);
    names.add(module.name);
    const routes = module.routes(deps);
    for (const route of routes) {
      if (!ADMIN_TOOLS_ROUTE_PREFIX.test(route.pattern.source))
        throw new Error(`Admin tools module ${module.name} must mount under /api/v1/admin-tools/.`);
    }
    return routes;
  });
  return [...foundation, ...extra];
}
