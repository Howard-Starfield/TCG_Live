// Roles tab data: button-role panels and bulk role jobs. The wire types mirror the server's feature-local
// types (apps/server/src/admin-tools/roles/types.ts); everything else comes from the frozen contract.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN_TOOLS_LIMITS as L, type BulkRoleJobDto, type BulkRoleJobRequestDto, type ButtonRoleButtonDto, type ButtonRolePanelDto,
  type GuildRoleDto, type SaveButtonRolePanelRequestDto } from '@tcg-live/core';
import { useAdminData } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export type RoleProblem = 'unknown' | 'managed' | 'above-bot' | 'everyone' | 'elevated';
export interface RoleWarning { roleId: string; problem: RoleProblem; message: string }
export type PanelMessageState = 'unpublished' | 'posted' | 'missing';
export interface ButtonRolePanelView extends ButtonRolePanelDto { requiredRoleId: string | null; messageState: PanelMessageState; warnings: RoleWarning[] }
export interface SavePanelBody extends SaveButtonRolePanelRequestDto { requiredRoleId: string | null }
export interface BulkRoleFailure { userId: string; error: string }
export interface BulkRoleJobDetail extends BulkRoleJobDto { failures: BulkRoleFailure[] }
export interface BulkRolePreview { total: number; sample: string[]; warning: RoleWarning | null }

export const rolesKeys = {
  panels: () => adminToolsKeys.feature('roles', 'panels'),
  jobs: () => adminToolsKeys.feature('roles', 'jobs'),
  job: (id: string) => adminToolsKeys.feature('roles', 'jobs', id)
};

/**
 * Staff-level permissions (Administrator, Manage Server, Manage Roles, Ban/Kick/Timeout, Mention Everyone...): the
 * server refuses to hand such a role out. GuildRoleDto does not carry it yet; read it when /admin-tools/guild sends it.
 */
export const isElevatedRole = (role: GuildRoleDto | undefined): boolean => (role as { elevated?: unknown } | undefined)?.elevated === true;

/** A role the bot can never assign, by the server's rules, or null. */
export function roleProblem(role: GuildRoleDto | undefined, guildId: string): RoleProblem | null {
  return !role ? 'unknown' : role.id === guildId ? 'everyone' : role.managed ? 'managed' : role.aboveBot ? 'above-bot'
    : isElevatedRole(role) ? 'elevated' : null;
}

export const ROLE_PROBLEM_TEXT: Record<RoleProblem, string> = { unknown: 'the role no longer exists', everyone: '@everyone cannot be assigned',
  managed: 'the role is managed by an integration', 'above-bot': "the role is at or above the bot's highest role",
  elevated: 'it has staff-level permissions, so the bot refuses to hand it out' };

/** Same rule as the server: not @everyone, not managed, below the bot's highest role, no staff permissions. */
export function rolePanelWarnings(buttons: readonly ButtonRoleButtonDto[], roles: readonly GuildRoleDto[], guildId: string): RoleWarning[] {
  return buttons.flatMap(button => {
    const role = roles.find(item => item.id === button.roleId);
    const problem = roleProblem(role, guildId);
    if (!problem) return [];
    const why = ROLE_PROBLEM_TEXT[problem];
    return [{ roleId: button.roleId, problem, message: `${button.label || 'Button'}: ${why}.` }];
  });
}

/** Pasted member IDs: any separators, de-duplicated; returns the IDs and the tokens that are not IDs. */
export function parseMemberIds(text: string): { ids: string[]; invalid: string[] } {
  const tokens = text.split(/[\s,;]+/).map(token => token.replace(/^<@!?(\d+)>$/, '$1')).filter(Boolean);
  const ids = [...new Set(tokens.filter(token => /^[1-9]\d{14,21}$/.test(token)))].slice(0, L.bulkRoleTargets);
  return { ids, invalid: tokens.filter(token => !/^[1-9]\d{14,21}$/.test(token)) };
}

export function usePanels() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: rolesKeys.panels(), enabled: access, staleTime: 15_000, retry: retryTransient,
    queryFn: ({ signal }) => api.request<{ panels: ButtonRolePanelView[] }>('GET', '/admin-tools/button-roles', signal ? { signal } : {}) });
}

export function usePanelMutations() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const onSettled = () => { void queryClient.invalidateQueries({ queryKey: rolesKeys.panels() }); };
  return {
    save: useMutation({ onSettled, mutationFn: ({ id, body }: { id: string | null; body: SavePanelBody }) =>
      id ? api.request<ButtonRolePanelView>('PUT', `/admin-tools/button-roles/${id}`, { body })
        : api.request<ButtonRolePanelView>('POST', '/admin-tools/button-roles', { body }) }),
    publish: useMutation({ onSettled, mutationFn: (id: string) => api.request<ButtonRolePanelView>('POST', `/admin-tools/button-roles/${id}/publish`) }),
    remove: useMutation({ onSettled, mutationFn: (id: string) => api.request<{ deleted: boolean }>('DELETE', `/admin-tools/button-roles/${id}`) })
  };
}

export function useBulkJobs() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: rolesKeys.jobs(), enabled: access, retry: retryTransient,
    queryFn: ({ signal }) => api.request<{ jobs: BulkRoleJobDto[] }>('GET', '/admin-tools/bulk-roles', signal ? { signal } : {}),
    // Poll while a job is queued or running.
    refetchInterval: query => query.state.data?.jobs.some(job => job.status === 'queued' || job.status === 'running') ? 2_000 : false });
}

export function useBulkJob(id: string | null) {
  const { api } = useAdminData();
  return useQuery({ queryKey: rolesKeys.job(id ?? ''), enabled: id !== null, retry: retryTransient,
    queryFn: ({ signal }) => api.request<BulkRoleJobDetail>('GET', `/admin-tools/bulk-roles/${id}`, signal ? { signal } : {}) });
}

export function useBulkMutations() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const onSettled = () => { void queryClient.invalidateQueries({ queryKey: rolesKeys.jobs() }); };
  return {
    preview: useMutation({ mutationFn: (body: Omit<BulkRoleJobRequestDto, 'reason'>) =>
      api.request<BulkRolePreview>('POST', '/admin-tools/bulk-roles/preview', { body }) }),
    queue: useMutation({ onSettled, mutationFn: (body: BulkRoleJobRequestDto) => api.request<BulkRoleJobDto>('POST', '/admin-tools/bulk-roles', { body }) }),
    cancel: useMutation({ onSettled, mutationFn: (id: string) => api.request<BulkRoleJobDto>('POST', `/admin-tools/bulk-roles/${id}/cancel`) })
  };
}
