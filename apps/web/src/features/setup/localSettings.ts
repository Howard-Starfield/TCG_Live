// GET/PUT /settings/local: "Allow dashboard actions" and voice monitoring, saved in the local setup profile.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalSettingsDto, LocalSettingsPatchDto } from '@tcg-live/core';
import { useCallback, useState } from 'react';
import { useAdminData, useSession } from '../../data';

export const LOCAL_SETTINGS_KEY = ['local-settings'] as const;

/** True when this runtime mounts the local settings routes (guided start). */
export function useLocalSettingsAvailable(): boolean {
  return useSession().session?.localSettings === true;
}

export interface LocalSettingsApi {
  settings: LocalSettingsDto | undefined;
  loading: boolean;
  error: string | null;
  saving: boolean;
  /** Saves, then re-reads the session so its capabilities follow the switch without signing in again. */
  save(patch: LocalSettingsPatchDto): Promise<boolean>;
}

export function useLocalSettings(): LocalSettingsApi {
  const { api } = useAdminData();
  const session = useSession();
  const available = session.session?.localSettings === true;
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: LOCAL_SETTINGS_KEY,
    queryFn: ({ signal }) => api.request<LocalSettingsDto>('GET', '/settings/local', { signal }),
    enabled: available
  });
  const { refresh } = session;
  const save = useCallback(async (patch: LocalSettingsPatchDto) => {
    setSaving(true); setSaveError(null);
    try {
      const next = await api.request<LocalSettingsDto>('PUT', '/settings/local', { body: patch });
      client.setQueryData(LOCAL_SETTINGS_KEY, next);
      await refresh();
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The setting could not be saved.');
      return false;
    } finally { setSaving(false); }
  }, [api, client, refresh]);
  return { settings: query.data, loading: available && query.isPending, saving, save,
    error: saveError ?? (query.error instanceof Error ? query.error.message : null) };
}
