// Tournament role management: create or adopt the two bot-managed roles, give the organizer the Organizer
// role, and describe the roles for the dashboard. Roles are adopted by stored ID only (never by name), the bot
// never hands out a managed, above-bot or elevated role, and Discord failures are reported, not thrown.
import { TOURNAMENT_ROLE_DEFAULTS, TOURNAMENT_ROLE_KINDS, type TournamentRoleDto, type TournamentRoleIdsDto, type TournamentRoleKind, type TournamentRoleProblem,
  type TournamentRolesDto, type TournamentRolesEnsureResultDto } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { discordFailure, isElevatedPermissions, roleProblem } from '../roles/guild-port.js';
import type { PortRoleDetail, TournamentRolesPort } from './port.js';
import type { TournamentRoleStore } from './store.js';

const ID_FIELD = { organizer: 'organizerRoleId', judge: 'judgeRoleId' } as const satisfies Record<TournamentRoleKind, keyof TournamentRoleIdsDto>;
export const roleIdOf = (ids: TournamentRoleIdsDto, kind: TournamentRoleKind): string | null => ids[ID_FIELD[kind]];

type Described = Awaited<ReturnType<TournamentRolesPort['describe']>>;

/** What is wrong with a stored role as a role the bot may assign, in the same terms as button roles. */
export function assignProblem(role: PortRoleDetail | undefined, guildId: string, botTopPosition: number): TournamentRoleProblem | null {
  if (!role) return 'missing';
  const problem = roleProblem({ id: role.id, managed: role.managed, position: role.position, elevated: isElevatedPermissions(role.permissions) },
    guildId, botTopPosition);
  switch (problem) {
    case null: return null;
    case 'managed': case 'above-bot': case 'elevated': return problem;
    default: return 'missing';
  }
}

export function problemText(problem: TournamentRoleProblem, role: { name: string } | null, botTopName: string | null, kind: TournamentRoleKind): string {
  const name = role?.name ?? TOURNAMENT_ROLE_DEFAULTS[kind].name;
  const bot = botTopName ?? 'the bot\'s role';
  switch (problem) {
    case 'not-created': return `${name} has not been created yet. Use Create TCG roles.`;
    case 'missing': return `${name} was deleted in Discord. Use Create TCG roles to make it again.`;
    case 'above-bot': return `Move the ${bot} role above ${name} in Server Settings > Roles.`;
    case 'managed': return `${name} is managed by an integration, so the bot cannot give it to anyone.`;
    case 'elevated': return `${name} has staff permissions (such as Manage Server or Ban Members), so the bot will not give it to anyone. Remove those permissions in Server Settings > Roles.`;
    case 'no-manage-roles': return 'The bot needs the Manage Roles permission. Use Grant missing permissions in the bot permissions card, then try again.';
  }
}

/**
 * Creates (or adopts, by stored ID) both roles, then gives `organizerId` the Organizer role. Never throws for a
 * Discord failure: each role reports created / adopted / failed and `problem` explains the first thing that went wrong.
 * The new IDs are saved the moment each role exists, so a failure part-way never leads to duplicates.
 */
export async function ensureTournamentRoles(port: TournamentRolesPort, store: TournamentRoleStore, guildId: string,
  organizerId: string, actor: OpsActor): Promise<TournamentRolesEnsureResultDto> {
  // One ensure per guild at a time (two tabs, or the card and the setup wizard): a second one waits, then adopts.
  const previous = ensureQueue.get(guildId) ?? Promise.resolve();
  const run = previous.then(() => ensureOnce(port, store, guildId, organizerId, actor));
  const tail = run.then(() => undefined, () => undefined);
  ensureQueue.set(guildId, tail);
  void tail.then(() => { if (ensureQueue.get(guildId) === tail) ensureQueue.delete(guildId); });
  return run;
}

const ensureQueue = new Map<string, Promise<void>>();

async function ensureOnce(port: TournamentRolesPort, store: TournamentRoleStore, guildId: string,
  organizerId: string, actor: OpsActor): Promise<TournamentRolesEnsureResultDto> {
  const result: TournamentRolesEnsureResultDto = { organizer: 'failed', judge: 'failed', assigned: null, problem: null };
  const fail = (text: string) => { result.problem ??= text; };
  const reason = `TCG Live tournament roles (${actor.kind}:${actor.id})`;
  let ids: TournamentRoleIdsDto;
  let state: Described;
  try { ids = await store.get(guildId); }
  catch { fail('The saved setup could not be read, so no roles were touched. Check data/discord-setup.json.'); return result; }
  try { state = await port.describe(); }
  catch (error) { fail(`Could not read the server's roles. ${discordFailure(error)}`); return result; }
  const byId = new Map(state.roles.map(role => [role.id, role]));
  const roles: Partial<Record<TournamentRoleKind, PortRoleDetail>> = {};
  for (const kind of TOURNAMENT_ROLE_KINDS) {
    const storedId = roleIdOf(ids, kind);
    const found = storedId ? byId.get(storedId) : undefined;
    if (found) { result[kind] = 'adopted'; roles[kind] = found; continue; }
    if (!state.canManageRoles) { fail(problemText('no-manage-roles', null, state.botTop.name, kind)); continue; }
    let created: PortRoleDetail;
    try { created = await port.create(kind); }
    catch (error) { fail(`Could not create ${TOURNAMENT_ROLE_DEFAULTS[kind].name}. ${discordFailure(error)}`); continue; }
    try { await store.set({ ...ids, [ID_FIELD[kind]]: created.id }); }
    catch { fail(`${created.name} was created but its ID could not be saved. Delete it in Server Settings > Roles and try again.`); continue; }
    ids = { ...ids, [ID_FIELD[kind]]: created.id };
    roles[kind] = created;
    result[kind] = 'created';
  }
  if (result.organizer === 'created' || result.judge === 'created') {
    // Creating roles moves the bot's own role up, so judge the new role against a fresh look at the order.
    try { state = await port.describe(); } catch { /* keep the earlier view */ }
  }
  const organizer = roles.organizer && state.roles.find(role => role.id === roles.organizer!.id) || roles.organizer;
  if (!organizer) return result;
  const problem = assignProblem(organizer, guildId, state.botTop.position);
  if (problem) { fail(problemText(problem, organizer, state.botTop.name, 'organizer')); return result; }
  if (!state.canManageRoles) { fail(problemText('no-manage-roles', null, state.botTop.name, 'organizer')); return result; }
  try { await port.addMember(organizerId, organizer.id, reason); result.assigned = organizerId; }
  catch (error) { fail(`Could not give ${organizer.name} to the organizer. ${discordFailure(error)}`); }
  return result;
}

/** The roles as the dashboard shows them: each role's state, problem and members. */
export async function describeTournamentRoles(port: TournamentRolesPort, store: TournamentRoleStore, guildId: string,
  legacy: readonly string[], candidateIds: readonly string[] = []): Promise<TournamentRolesDto> {
  const ids = await store.get(guildId);
  const state = await port.describe();
  const byId = new Map(state.roles.map(role => [role.id, role]));
  const present = TOURNAMENT_ROLE_KINDS.flatMap(kind => { const id = roleIdOf(ids, kind); return id && byId.has(id) ? [id] : []; });
  const holders = present.length ? await port.holders(present, candidateIds).catch(() => ({ members: [], complete: false })) :
    { members: [], complete: true };
  const roles = TOURNAMENT_ROLE_KINDS.map((kind): TournamentRoleDto => {
    const roleId = roleIdOf(ids, kind);
    const role = roleId ? byId.get(roleId) : undefined;
    const problem: TournamentRoleProblem | null = !state.canManageRoles ? 'no-manage-roles' : !roleId ? 'not-created' :
      !role ? 'missing' : assignProblem(role, guildId, state.botTop.position);
    const members = role ? holders.members.filter(member => member.roleIds.includes(role.id))
      .map(({ id, displayName, avatarUrl }) => ({ id, displayName, avatarUrl })) : [];
    return { kind, roleId: role ? role.id : roleId, name: role?.name ?? null, color: role?.color ?? null, position: role?.position ?? null,
      problem, problemText: problem ? problemText(problem, role ?? null, state.botTop.name, kind) : null,
      members, membersComplete: role ? holders.complete : true };
  });
  return { guildId, ownerId: state.ownerId, canManageRoles: state.canManageRoles, botTopRole: state.botTop, roles,
    legacyStaffRoleIds: [...legacy] };
}

/** One role's state without listing members: for the routes that change it. */
export async function inspectTournamentRole(port: TournamentRolesPort, store: TournamentRoleStore, guildId: string,
  kind: TournamentRoleKind): Promise<{ roleId: string | null; role: PortRoleDetail | null; problem: TournamentRoleProblem | null; text: string | null }> {
  const ids = await store.get(guildId);
  const state = await port.describe();
  const roleId = roleIdOf(ids, kind);
  const role = roleId ? state.roles.find(item => item.id === roleId) ?? null : null;
  const problem: TournamentRoleProblem | null = !state.canManageRoles ? 'no-manage-roles' : !roleId ? 'not-created' :
    !role ? 'missing' : assignProblem(role, guildId, state.botTop.position);
  return { roleId, role, problem, text: problem ? problemText(problem, role, state.botTop.name, kind) : null };
}
