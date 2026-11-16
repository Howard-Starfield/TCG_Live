// Tournament staff: two bot-managed Discord roles (TCG Organizer, TCG Judge). The server owner always counts as
// organizer; legacy staff roles (cases.staffRoleIds) count as judge. The old organizer Discord ID (config.adminId)
// is NOT a staff source. Discord's own command permissions decide who SEES the commands; this decides who may RUN them.

import type { StaffAction, TournamentRoleIdsDto, TournamentRoleKind } from '@tcg-live/core';

export type StaffVia = 'owner' | 'role' | 'legacy-staff-role';
export interface StaffSources { roles: TournamentRoleIdsDto | null; legacyStaffRoleIds: readonly string[] }
export interface StaffSubject { userId: string; roleIds: readonly string[]; ownerId: string | null }
/** `roleId` is the Discord role that matched (absent for the owner), so callers can show its real name. */
export interface ResolvedStaff { role: TournamentRoleKind; via: StaffVia; roleId?: string }

/** Owner, then the organizer role, then the judge role, then a legacy staff role (judge). Null when none match.
 *  Unreadable sources (roles null, no legacy ids) leave only the owner. */
export function resolveStaff(subject: StaffSubject, sources: StaffSources): ResolvedStaff | null {
  if (subject.ownerId !== null && subject.userId === subject.ownerId) return { role: 'organizer', via: 'owner' };
  const held = new Set(subject.roleIds);
  const { organizerRoleId, judgeRoleId } = sources.roles ?? { organizerRoleId: null, judgeRoleId: null };
  if (organizerRoleId && held.has(organizerRoleId)) return { role: 'organizer', via: 'role', roleId: organizerRoleId };
  if (judgeRoleId && held.has(judgeRoleId)) return { role: 'judge', via: 'role', roleId: judgeRoleId };
  const legacy = sources.legacyStaffRoleIds.find(id => held.has(id));
  if (legacy) return { role: 'judge', via: 'legacy-staff-role', roleId: legacy };
  return null;
}

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


export const STAFF_DENIED = 'Only the organizer or tournament staff (TCG Organizer or TCG Judge) can do that. An admin can create the roles in the dashboard (Admin tools > Settings > Tournament roles).';

const ACTION_LABELS: Record<StaffAction, string> = {
  publish: 'publish the tournament', delayStart: 'delay or start the tournament', signupClose: 'close signup',
  signupReopen: 'reopen signup', signupRemove: 'remove a player from signup', signupAdd: 'add a player to signup',
  refresh: 'refresh the cards', checkinFor: 'check a player in', resolve: 'resolve a match', correct: 'correct a result',
  judgeResume: 'resume a match', judgeClose: 'close a judge request', evidenceSubmit: 'submit evidence',
  evidenceReply: 'reply to evidence', moderation: 'moderate members',
};

/** The refusal for a judge who tries an organizer-only action. */
export function judgeDenied(action: StaffAction): string {
  return `A TCG Judge cannot ${ACTION_LABELS[action]}. Ask a TCG Organizer.`;
}

/** The refusal for staff seated in the match they would rule on. */
export function rulingConflictText(matchId: string, dashboard: boolean): string {
  const text = `You are playing in ${matchId}, so another organizer or judge must rule on it.`;
  return dashboard ? `${text} Add a TCG Judge in Admin tools > Settings > Tournament roles.` : text;
}

/** How many staff members other than the seated players can be confirmed, and whether the lookup was complete. */
export type StaffCoverage = (seatedIds: readonly string[]) => Promise<{ otherStaff: number; complete: boolean }>;
