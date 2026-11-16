// The slice of Discord that tournament role management needs, behind one interface: the live guild in the
// Discord runtime and setup, the synthetic demo server in the demo and tests.
import { GatewayIntentBits, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { TOURNAMENT_ROLE_DEFAULTS, type TournamentRoleEditDto, type TournamentRoleKind } from '@tcg-live/core';
import { DEMO_ORGANIZER_ID, DEMO_ROLE_IDS, type DemoGuild } from '../demo-guild.js';

export interface PortRoleDetail { id: string; name: string; color: number; position: number; managed: boolean; permissions: bigint }
export interface PortMember { id: string; displayName: string | null; avatarUrl: string | null; roleIds: string[] }

export interface TournamentRolesPort {
  describe(): Promise<{ ownerId: string; canManageRoles: boolean; botTop: { id: string; name: string; position: number }; roles: PortRoleDetail[] }>;
  /** A new role with permissions 0n, positioned directly under the bot's top role. */
  create(kind: TournamentRoleKind): Promise<PortRoleDetail>;
  edit(roleId: string, edit: TournamentRoleEditDto): Promise<PortRoleDetail>;
  addMember(userId: string, roleId: string, reason: string): Promise<void>;
  removeMember(userId: string, roleId: string, reason: string): Promise<void>;
  /**
   * Members holding any of the roles. `complete` is false when the list may miss members (no Server Members
   * intent, or the full fetch failed): then it is the cache plus the owner plus `candidateIds`, each fetched by ID.
   */
  holders(roleIds: readonly string[], candidateIds?: readonly string[]): Promise<{ members: PortMember[]; complete: boolean }>;
}

const CANDIDATE_LIMIT = 25;
/** Never reused, so a role deleted and made again gets a new ID like Discord's. */
let demoRoleSerial = 700;

async function collectHolders(guild: Guild, roleIds: readonly string[], intentOn: boolean,
  candidateIds: readonly string[]): Promise<{ members: GuildMember[]; complete: boolean }> {
  const wanted = new Set(roleIds);
  if (!wanted.size) return { members: [], complete: true };
  const holds = (member: GuildMember) => member.roles.cache.some((_role, id) => wanted.has(id));
  let complete = intentOn;
  if (intentOn && guild.members.cache.size < guild.memberCount) {
    try { await guild.members.fetch(); } catch { complete = false; }
  }
  const found = new Map<string, GuildMember>();
  for (const member of guild.members.cache.values()) if (holds(member)) found.set(member.id, member);
  if (!complete) {
    const ids = [...new Set([guild.ownerId, ...candidateIds])].slice(0, CANDIDATE_LIMIT);
    for (const id of ids) {
      if (found.has(id)) continue;
      const member = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
      if (member && holds(member)) found.set(id, member);
    }
  }
  return { members: [...found.values()], complete };
}

const intentIsOn = (guild: Guild) => guild.client.options.intents.has(GatewayIntentBits.GuildMembers);

/** Ids of the members holding any of the roles; `complete` is false without the Server Members intent. */
export async function tournamentRoleHolders(guild: Guild, roleIds: readonly string[],
  intentOn: boolean): Promise<{ ids: string[]; complete: boolean }> {
  const { members, complete } = await collectHolders(guild, roleIds, intentOn, []);
  return { ids: members.map(member => member.id), complete };
}

const detail = (role: { id: string; name: string; colors: { primaryColor: number }; position: number; managed: boolean;
  permissions: { bitfield: bigint } }): PortRoleDetail => ({ id: role.id, name: role.name, color: role.colors.primaryColor,
  position: role.position, managed: role.managed, permissions: role.permissions.bitfield });

export function discordTournamentRolesPort(guild: Guild): TournamentRolesPort {
  const describe = async () => {
    const [roles, me] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe()]);
    const top = me.roles.highest;
    return { ownerId: guild.ownerId, canManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
      botTop: { id: top.id, name: top.name, position: top.position }, roles: [...roles.values()].map(detail) };
  };
  return {
    describe,
    async create(kind) {
      const defaults = TOURNAMENT_ROLE_DEFAULTS[kind];
      const created = await guild.roles.create({ name: defaults.name, colors: { primaryColor: defaults.color },
        permissions: 0n, hoist: false, mentionable: false, reason: 'TCG Live tournament role' });
      // New roles start at the bottom. The role exists and is below the bot either way, so a failed move only costs the tidy order.
      const moved = await describe().then(({ botTop }) => guild.roles.setPosition(created, Math.max(1, botTop.position - 1)))
        .catch(() => created);
      return detail(moved);
    },
    async edit(roleId, edit) {
      const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId);
      if (!role) throw Object.assign(new Error('Unknown role'), { code: 10011 });
      const updated = await role.edit({ ...(edit.name !== undefined ? { name: edit.name } : {}),
        ...(edit.color !== undefined ? { colors: { primaryColor: edit.color } } : {}), reason: 'TCG Live tournament role' });
      return detail(updated);
    },
    async addMember(userId, roleId, reason) { await guild.members.addRole({ user: userId, role: roleId, reason: reason.slice(0, 512) }); },
    async removeMember(userId, roleId, reason) { await guild.members.removeRole({ user: userId, role: roleId, reason: reason.slice(0, 512) }); },
    async holders(roleIds, candidateIds = []) {
      const { members, complete } = await collectHolders(guild, roleIds, intentIsOn(guild), candidateIds);
      return { complete, members: members.map(member => ({ id: member.id, displayName: member.displayName || null,
        avatarUrl: member.displayAvatarURL({ size: 64 }), roleIds: [...member.roles.cache.keys()] })) };
    }
  };
}

/** In-memory port over the demo server: creating, editing and assigning change the shared DemoGuild. */
export class DemoTournamentRolesPort implements TournamentRolesPort {
  /** Set by tests to make every change fail like a Discord permission error. */
  failChanges = false;
  constructor(private readonly demo: DemoGuild) {}
  private botRole() {
    return this.demo.roles.find(role => role.id === DEMO_ROLE_IDS.bot) ??
      this.demo.roles.filter(role => role.aboveBot).sort((a, b) => a.position - b.position)[0]!;
  }
  private toDetail(role: DemoGuild['roles'][number]): PortRoleDetail {
    return { id: role.id, name: role.name, color: role.color, position: role.position, managed: role.managed,
      permissions: role.elevated ? PermissionFlagsBits.ManageGuild : 0n };
  }
  async describe() {
    const bot = this.botRole();
    return { ownerId: this.demo.ownerId ?? DEMO_ORGANIZER_ID, canManageRoles: true,
      botTop: { id: bot.id, name: bot.name, position: bot.position }, roles: this.demo.roles.map(role => this.toDetail(role)) };
  }
  private denied() { return Object.assign(new Error('Missing permissions'), { code: 50013 }); }
  async create(kind: TournamentRoleKind) {
    if (this.failChanges) throw this.denied();
    const top = this.botRole().position;
    // The new role takes the bot's place and the bot (and everything above it) moves up one: directly under the bot.
    for (const role of this.demo.roles) if (role.position >= top && role.id !== this.demo.id) role.position += 1;
    const defaults = TOURNAMENT_ROLE_DEFAULTS[kind];
    let id: string;
    do { id = `2000000000${String(++demoRoleSerial).padStart(9, '0')}`; } while (this.demo.roles.some(item => item.id === id));
    const role = { id, name: defaults.name, color: defaults.color, position: top, managed: false, aboveBot: false, elevated: false };
    this.demo.roles.push(role);
    return this.toDetail(role);
  }
  async edit(roleId: string, edit: TournamentRoleEditDto) {
    if (this.failChanges) throw this.denied();
    const role = this.demo.roles.find(item => item.id === roleId);
    if (!role) throw Object.assign(new Error('Unknown role'), { code: 10011 });
    if (edit.name !== undefined) role.name = edit.name;
    if (edit.color !== undefined) role.color = edit.color;
    return this.toDetail(role);
  }
  private change(userId: string, roleId: string, action: 'add' | 'remove') {
    if (this.failChanges) throw this.denied();
    const member = this.demo.members.find(item => item.id === userId);
    if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 });
    if (!this.demo.roles.some(item => item.id === roleId)) throw Object.assign(new Error('Unknown role'), { code: 10011 });
    member.roleIds = action === 'add' ? [...new Set([...member.roleIds, roleId])] : member.roleIds.filter(id => id !== roleId);
  }
  async addMember(userId: string, roleId: string) { this.change(userId, roleId, 'add'); }
  async removeMember(userId: string, roleId: string) { this.change(userId, roleId, 'remove'); }
  async holders(roleIds: readonly string[]) {
    const wanted = new Set(roleIds);
    return { complete: true, members: this.demo.members.filter(member => !member.bot && member.roleIds.some(id => wanted.has(id)))
      .map(member => ({ id: member.id, displayName: member.displayName ?? member.username, avatarUrl: member.avatarUrl,
        roleIds: member.roleIds.slice() })) };
  }
}
