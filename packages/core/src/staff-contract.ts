// Tournament staff roles: the two bot-managed Discord roles (TCG Organizer, TCG Judge), what each may do,
// and the DTOs the dashboard uses to manage them.

import type { Snowflake } from './admin-contract.js';

export const TOURNAMENT_ROLE_KINDS = ['organizer', 'judge'] as const;
export type TournamentRoleKind = typeof TOURNAMENT_ROLE_KINDS[number];

export const TOURNAMENT_ROLE_DEFAULTS: Readonly<Record<TournamentRoleKind, { name: string; color: number }>> = {
  organizer: { name: 'TCG Organizer', color: 0xE67E22 },
  judge: { name: 'TCG Judge', color: 0x3498DB },
};

/** Discord's 20 standard role-colour swatches (Server Settings > Roles). */
export const DISCORD_ROLE_COLOR_PRESETS: readonly number[] = [
  0x1ABC9C, 0x2ECC71, 0x3498DB, 0x9B59B6, 0xE91E63, 0xF1C40F, 0xE67E22, 0xE74C3C, 0x95A5A6, 0x607D8B,
  0x11806A, 0x1F8B4C, 0x206694, 0x71368A, 0xAD1457, 0xC27C0E, 0xA84300, 0x992D22, 0x979C9F, 0x546E7A,
];

export interface TournamentRoleIdsDto { guildId: Snowflake; organizerRoleId: Snowflake | null; judgeRoleId: Snowflake | null }

export type TournamentRoleProblem = 'not-created' | 'missing' | 'above-bot' | 'managed' | 'elevated' | 'no-manage-roles';

export interface TournamentRoleMemberDto { id: Snowflake; displayName: string | null; avatarUrl: string | null }

export interface TournamentRoleDto {
  kind: TournamentRoleKind; roleId: Snowflake | null; name: string | null; color: number | null; position: number | null;
  problem: TournamentRoleProblem | null; problemText: string | null;
  members: TournamentRoleMemberDto[]; membersComplete: boolean;
}

export interface TournamentRolesDto {
  guildId: Snowflake; ownerId: Snowflake | null; canManageRoles: boolean;
  botTopRole: { id: Snowflake; name: string; position: number } | null;
  roles: TournamentRoleDto[]; legacyStaffRoleIds: Snowflake[];
}

/** PATCH /api/v1/admin-tools/tournament-roles/:kind. name is 1-100 characters; color is 0..0xFFFFFF. */
export interface TournamentRoleEditDto { name?: string; color?: number }

export interface TournamentRolesEnsureResultDto {
  organizer: 'created' | 'adopted' | 'failed'; judge: 'created' | 'adopted' | 'failed';
  assigned: Snowflake | null; problem: string | null;
}

export const STAFF_ACTIONS = ['publish', 'delayStart', 'signupClose', 'signupReopen', 'signupRemove', 'signupAdd', 'refresh',
  'checkinFor', 'resolve', 'correct', 'judgeResume', 'judgeClose', 'evidenceSubmit', 'evidenceReply', 'moderation'] as const;
export type StaffAction = typeof STAFF_ACTIONS[number];

/** Rulings on a match: staff seated in that match may not make them. */
export const RULING_ACTIONS: ReadonlySet<StaffAction> =
  new Set<StaffAction>(['resolve', 'correct', 'judgeResume', 'judgeClose', 'evidenceReply']);

const JUDGE_ACTIONS: ReadonlySet<StaffAction> =
  new Set<StaffAction>(['checkinFor', 'resolve', 'correct', 'judgeResume', 'judgeClose', 'evidenceSubmit', 'evidenceReply']);

/** Organizers may do every staff action; judges only rulings, check-in-for and evidence. */
export function staffMay(role: TournamentRoleKind, action: StaffAction): boolean {
  return role === 'organizer' || JUDGE_ACTIONS.has(action);
}
