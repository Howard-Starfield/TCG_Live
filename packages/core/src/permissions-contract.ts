// Bot permission check: what the enabled features need from Discord, what the bot is missing, and the
// invite link that grants it. GET /api/v1/admin-tools/permissions, the setup Readiness step and the
// dashboard banner all read these shapes.

export type PermissionIssueSeverity = 'blocking' | 'warning';

/**
 * How the issue is fixed:
 * - 'permission': a server-wide permission is missing; the invite link grants it.
 * - 'overwrite': the server-wide permission is there but a channel's permission settings deny it.
 * - 'hierarchy': a role sits at or above the bot's highest role (or is managed by an integration); drag roles in Server Settings.
 * - 'intent': a privileged gateway intent is off in the Developer Portal.
 * - 'missing': a configured channel or role no longer exists or the bot cannot see it.
 */
export type PermissionIssueKind = 'permission' | 'overwrite' | 'hierarchy' | 'intent' | 'missing';

export type PermissionScopeDto =
  | { kind: 'guild' }
  | { kind: 'channel'; id: string; name: string }
  | { kind: 'role'; id: string; name: string };

export interface PermissionIssueDto {
  severity: PermissionIssueSeverity;
  kind: PermissionIssueKind;
  /** Stable feature key from the permission table, e.g. 'stickies.post'. */
  featureId: string;
  /** Human feature group, e.g. 'Sticky messages'. */
  feature: string;
  /** Human permission name as Discord shows it ('Manage Roles', 'Server Members Intent'). */
  permission: string;
  scope: PermissionScopeDto;
  /** One sentence: what breaks. */
  why: string;
  /** One sentence: how to fix it. */
  fix: string;
}

/** GET /api/v1/admin-tools/permissions (and SetupCheckDto.permissions). Never contains tokens. */
export interface PermissionReportDto {
  /** Null until the first check finished. */
  checkedAtMs: number | null;
  /** True when there are no issues at all. */
  ok: boolean;
  issues: PermissionIssueDto[];
  /** OAuth2 invite for the enabled features' permissions (bot + applications.commands), or null without an application ID. */
  inviteUrl: string | null;
  /** The same invite with every feature's permissions. */
  inviteUrlAll: string | null;
  /** Decimal permissions integer for the enabled features. */
  permissionsInteger: string;
  /** Decimal permissions integer for all features. */
  permissionsIntegerAll: string;
  /** The bot's highest role (for "drag the bot's role above ..."), when known. */
  botRoleName: string | null;
  /** Why the check could not run (Discord offline, setup unfinished); null when it ran. */
  unavailable: string | null;
}

/** Pushed in RuntimeStatusDto.permissions so the dashboard refreshes without polling. */
export interface PermissionSummaryDto { checkedAtMs: number; blocking: number; warnings: number }

export function summarizePermissionIssues(issues: readonly PermissionIssueDto[], checkedAtMs: number): PermissionSummaryDto {
  return { checkedAtMs, blocking: issues.filter(issue => issue.severity === 'blocking').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length };
}
