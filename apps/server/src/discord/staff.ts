// Tournament staff (next wave, agent G1): the configured organizer (config.adminId) and members holding one
// of the staff roles saved in admin-tools settings (cases.staffRoleIds) may run the staff commands
// (`/tcg-staff`, `/tcg-admin` moderation). Discord's own command permissions (default_member_permissions,
// Server Settings > Integrations) decide who SEES the commands; this check decides who may RUN them.

/** Role IDs of an interaction's member: a cached GuildMember (roles.cache) or a raw API member (roles: string[]). */
export function memberRoleIds(member: unknown): string[] {
  if (!member || typeof member !== 'object') return [];
  const roles = (member as { roles?: unknown }).roles;
  if (Array.isArray(roles)) return roles.filter((id): id is string => typeof id === 'string');
  const cache = (roles as { cache?: { keys(): Iterable<string> } } | undefined)?.cache;
  // A cached GuildMember also lists @everyone (the guild ID); the raw API member does not. Drop it, so a
  // staff list that names @everyone never makes every member staff, whichever shape Discord sent.
  const everyone = (member as { guild?: { id?: unknown } }).guild?.id;
  return cache ? [...cache.keys()].filter(id => id !== everyone) : [];
}

export interface StaffCheck {
  userId: string;
  adminId: string;
  roleIds: readonly string[];
  staffRoleIds: readonly string[] | undefined;
}

/** True for the configured organizer or a member with a configured staff role. */
export function isTournamentStaff(check: StaffCheck): boolean {
  if (check.userId === check.adminId) return true;
  const staff = new Set(check.staffRoleIds ?? []);
  return check.roleIds.some(id => staff.has(id));
}

export const STAFF_DENIED = 'Only the organizer or tournament staff can do that. An admin can choose staff roles in the dashboard (Admin tools > Settings > Cases).';
