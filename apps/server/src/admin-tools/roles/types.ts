// Feature-local wire types for button roles and bulk roles (agent C). They extend the frozen contract
// additively; apps/web/src/features/admin-tools/roles/types.ts mirrors them.
import type { BulkRoleJobDto, BulkRoleJobRequestDto, ButtonRolePanelDto, SaveButtonRolePanelRequestDto } from '@tcg-live/core';

export type RoleProblem = 'unknown' | 'managed' | 'above-bot' | 'everyone' | 'elevated';
export interface RoleWarningDto { roleId: string; problem: RoleProblem; message: string }

/** 'missing': the posted message was deleted in Discord; the dashboard offers Repost. */
export type PanelMessageState = 'unpublished' | 'posted' | 'missing';

export interface ButtonRolePanelViewDto extends ButtonRolePanelDto {
  /** Members must hold this role to use the panel; null for anyone. */
  requiredRoleId: string | null;
  messageState: PanelMessageState;
  /** Roles the bot cannot assign (managed, at/above the bot, deleted). Saved anyway; clicks on them fail politely. */
  warnings: RoleWarningDto[];
}
/** POST /api/v1/admin-tools/button-roles, PUT /api/v1/admin-tools/button-roles/:id */
export interface SaveButtonRolePanelExtDto extends SaveButtonRolePanelRequestDto { requiredRoleId?: string | null }
export interface ButtonRolePanelListDto { panels: ButtonRolePanelViewDto[] }

export interface BulkRoleFailureDto { userId: string; error: string }
export interface BulkRoleJobDetailDto extends BulkRoleJobDto { failures: BulkRoleFailureDto[] }
export interface BulkRoleJobListDto { jobs: BulkRoleJobDto[] }
/** POST /api/v1/admin-tools/bulk-roles/preview (dry run; reason optional). */
export type BulkRolePreviewRequestDto = Omit<BulkRoleJobRequestDto, 'reason'> & { reason?: string };
export interface BulkRolePreviewDto { total: number; sample: string[]; warning: RoleWarningDto | null }
