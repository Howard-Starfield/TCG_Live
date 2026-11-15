// Bot permission check data: GET /admin-tools/permissions, POST /admin-tools/permissions/recheck. The
// server pushes a summary in the runtime status after every check; a new checkedAtMs refetches the report.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PermissionReportDto } from '@tcg-live/core';
import { useEffect } from 'react';
import { useAdminData, useRuntimeStatus, type ApiClient } from '../../data';
import { adminToolsKeys, useAdminToolsAccess } from '../admin-tools/api';
import { retryTransient } from '../evidence/api';

export const permissionKeys = { report: () => adminToolsKeys.feature('permissions') };

export const getPermissionReport = (api: ApiClient, signal?: AbortSignal) =>
  api.request<PermissionReportDto>('GET', '/admin-tools/permissions', signal ? { signal } : {});
export const recheckPermissionReport = (api: ApiClient) =>
  api.request<PermissionReportDto>('POST', '/admin-tools/permissions/recheck');

export function usePermissionReport() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  const status = useRuntimeStatus();
  const client = useQueryClient();
  const query = useQuery({ queryKey: permissionKeys.report(), queryFn: ({ signal }) => getPermissionReport(api, signal),
    enabled: access, staleTime: 30_000, retry: retryTransient });
  const pushed = status.data?.permissions?.checkedAtMs ?? null;
  const loaded = query.data?.checkedAtMs ?? null;
  useEffect(() => {
    if (access && pushed !== null && pushed !== loaded) void client.invalidateQueries({ queryKey: permissionKeys.report() });
  }, [access, client, pushed, loaded]);
  return query;
}

export function useRecheckPermissions() {
  const { api } = useAdminData();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => recheckPermissionReport(api),
    onSuccess: report => { client.setQueryData(permissionKeys.report(), report); }
  });
}
