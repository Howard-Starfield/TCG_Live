// Admin tools routes for the two bot-managed tournament roles (TCG Organizer, TCG Judge):
//   GET    /api/v1/admin-tools/tournament-roles                         (members.read)
//   POST   /api/v1/admin-tools/tournament-roles/ensure                  { organizerId? }
//   PATCH  /api/v1/admin-tools/tournament-roles/:kind                   { name?, color? }
//   PUT | DELETE /api/v1/admin-tools/tournament-roles/:kind/members/:userId
// Everything except the GET needs server.manage and is audited.
import { TOURNAMENT_ROLE_KINDS, type TournamentRoleEditDto, type TournamentRoleKind } from '@tcg-live/core';
import { readEmptyBody, readJsonBody, strictObject } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { SetupProfileStore } from '../../onboarding/profile.js';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { badRequest, onlyParams, readableText, SNOWFLAKE, type OpsRoute } from '../../ops/http.js';
import { DEMO_ROLE_IDS, type DemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { discordCall } from '../roles/port.js';
import { DemoTournamentRolesPort, discordTournamentRolesPort, type TournamentRolesPort } from './port.js';
import { describeTournamentRoles, ensureTournamentRoles, inspectTournamentRole } from './service.js';
import { MemoryTournamentRoleStore, profileTournamentRoleStore, type TournamentRoleStore } from './store.js';

const KIND = `(${TOURNAMENT_ROLE_KINDS.join('|')})`;
const REASON = `TCG Live tournament role (${LOCAL_ADMIN.kind}:${LOCAL_ADMIN.id})`;
const demoPorts = new WeakMap<DemoGuild, DemoTournamentRolesPort>();

export interface TournamentRolesRouteOverrides {
  store?: TournamentRoleStore;
  /** The organizer chosen in setup; defaults to the setup profile (live) or nobody (demo). */
  setupOrganizer?(): Promise<string | null>;
  port?(): Promise<TournamentRolesPort>;
}

export function tournamentRolesRouteModule(overrides: TournamentRolesRouteOverrides = {}): AdminToolsRouteModule {
  return { name: 'tournament-roles', routes: deps => tournamentRolesRoutes(deps, overrides) };
}

function parseEdit(value: unknown): TournamentRoleEditDto {
  const body = strictObject(value, ['name', 'color']);
  const edit: TournamentRoleEditDto = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || !readableText(name, 100)) throw badRequest('The role name must be 1-100 readable characters.');
    edit.name = name;
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'number' || !Number.isInteger(body.color) || body.color < 0 || body.color > 0xFFFFFF)
      throw badRequest('The colour must be a whole number from 0 to 16777215.');
    edit.color = body.color;
  }
  if (edit.name === undefined && edit.color === undefined) throw badRequest('Give a name or a colour to change.');
  return edit;
}

function tournamentRolesRoutes(deps: AdminToolsRouteDeps, overrides: TournamentRolesRouteOverrides): OpsRoute[] {
  const demo = deps.demo;
  // The demo and tests keep the role IDs in memory (the demo server already has both roles); live uses the setup profile.
  const raw: TournamentRoleStore = overrides.store ?? (deps.storage === 'postgres' ? profileTournamentRoleStore() :
    new MemoryTournamentRoleStore(demo && demo.roles.some(role => role.id === DEMO_ROLE_IDS.tcgOrganizer) ?
      { guildId: demo.id, organizerRoleId: DEMO_ROLE_IDS.tcgOrganizer, judgeRoleId: DEMO_ROLE_IDS.tcgJudge } : undefined));
  // A profile that cannot be read is a local file problem, not a Discord one.
  const unreadable = () => new HttpError(503, 'unavailable', 'The setup profile (data/discord-setup.json) could not be read or saved. Check the file and try again.');
  const store: TournamentRoleStore = {
    get: async guildId => { try { return await raw.get(guildId); } catch { throw unreadable(); } },
    set: async value => { try { await raw.set(value); } catch { throw unreadable(); } }
  };
  const port = async (): Promise<TournamentRolesPort> => {
    if (overrides.port) return overrides.port();
    if (demo) {
      let existing = demoPorts.get(demo);
      if (!existing) { existing = new DemoTournamentRolesPort(demo); demoPorts.set(demo, existing); }
      return existing;
    }
    if (!deps.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
    return discordTournamentRolesPort(await deps.discord.guild());
  };
  const setupOrganizer = overrides.setupOrganizer ?? (async () => {
    if (deps.storage !== 'postgres') return null;
    return (await new SetupProfileStore().read().catch(() => null))?.selection?.adminId ?? null;
  });
  const refuse = (text: string | null) => new HttpError(409, 'rule', text ?? 'That role cannot be changed right now.');
  const kindOf = (params: string[]) => params[0] as TournamentRoleKind;
  const memberId = (value: string | undefined) => {
    if (!value || !SNOWFLAKE.test(value)) throw badRequest('That is not a member ID.');
    return value;
  };

  return [
    { pattern: /^\/api\/v1\/admin-tools\/tournament-roles$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        const legacy = (await deps.currentSettings().catch(() => null))?.cases.staffRoleIds ?? [];
        const candidates = [await setupOrganizer().catch(() => null)].filter((id): id is string => !!id);
        sendJson(response, 200, await discordCall(async () =>
          describeTournamentRoles(await port(), store, deps.guildId(), legacy, candidates)));
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/tournament-roles\/ensure$/, methods: {
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const raw = await readJsonBody(request);
        const body = raw === undefined ? {} : strictObject(raw, ['organizerId']);
        if (body.organizerId !== undefined && (typeof body.organizerId !== 'string' || !SNOWFLAKE.test(body.organizerId)))
          throw badRequest('organizerId must be a member ID.');
        const guild = await discordCall(port);
        const organizerId = (body.organizerId as string | undefined) ?? await setupOrganizer().catch(() => null) ??
          (await discordCall(() => guild.describe())).ownerId;
        const result = await ensureTournamentRoles(guild, store, deps.guildId(), organizerId, LOCAL_ADMIN);
        const ids = await store.get(deps.guildId()).catch(() => null);
        if (result.organizer === 'created' || result.judge === 'created')
          await deps.recordAudit('tournament_roles.created', { organizer: result.organizer, judge: result.judge,
            organizerRoleId: ids?.organizerRoleId ?? null, judgeRoleId: ids?.judgeRoleId ?? null });
        if (result.assigned) await deps.recordAudit('tournament_roles.member_added', { kind: 'organizer',
          roleId: ids?.organizerRoleId ?? null, userId: result.assigned });
        if (result.organizer !== 'failed' || result.judge !== 'failed') deps.notify('tournament-roles');
        sendJson(response, 200, result);
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/tournament-roles/${KIND}$`), methods: {
      PATCH: { access: 'server.manage', run: async ({ request, response, params }) => {
        const kind = kindOf(params);
        const edit = parseEdit(await readJsonBody(request));
        const guild = await discordCall(port);
        const state = await discordCall(() => inspectTournamentRole(guild, store, deps.guildId(), kind));
        // Renaming and recolouring are harmless on a role with staff permissions, so 'elevated' does not block an edit.
        if (state.problem && state.problem !== 'elevated') throw refuse(state.text);
        await discordCall(() => guild.edit(state.roleId!, edit));
        await deps.recordAudit('tournament_roles.updated', { kind, roleId: state.roleId, ...edit });
        deps.notify('tournament-roles', kind);
        sendJson(response, 200, { applied: true });
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/tournament-roles/${KIND}/members/([0-9]+)$`), methods: {
      PUT: { access: 'server.manage', run: async ({ request, response, params }) => {
        await readEmptyBody(request);
        const kind = kindOf(params);
        const userId = memberId(params[1]);
        const guild = await discordCall(port);
        const state = await discordCall(() => inspectTournamentRole(guild, store, deps.guildId(), kind));
        if (state.problem) throw refuse(state.text);
        await discordCall(() => guild.addMember(userId, state.roleId!, REASON));
        await deps.recordAudit('tournament_roles.member_added', { kind, roleId: state.roleId, userId });
        deps.notify('tournament-roles', kind);
        sendJson(response, 200, { applied: true });
      } },
      DELETE: { access: 'server.manage', run: async ({ response, params }) => {
        const kind = kindOf(params);
        const userId = memberId(params[1]);
        const guild = await discordCall(port);
        const state = await discordCall(() => inspectTournamentRole(guild, store, deps.guildId(), kind));
        if (state.problem && state.problem !== 'elevated') throw refuse(state.text);
        await discordCall(() => guild.removeMember(userId, state.roleId!, REASON));
        await deps.recordAudit('tournament_roles.member_removed', { kind, roleId: state.roleId, userId });
        deps.notify('tournament-roles', kind);
        sendJson(response, 200, { applied: true });
      } }
    } }
  ];
}
