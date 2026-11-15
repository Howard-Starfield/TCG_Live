// Admin tools data layer: access checks, the versioned settings document (with the 409 flow), status and
// guild metadata (roles/channels for pickers). Feature tabs reuse these; their own endpoints live in their folders.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminToolsSettingsBodyDto, AdminToolsSettingsConflictDto, AdminToolsSettingsDto, AdminToolsSettingsSection,
  AdminToolsStatusDto, Capability, GuildMetaDto } from '@tcg-live/core';
import { useCallback, useState } from 'react';
import { ApiError, useAdminData, useSession, type ApiClient } from '../../data';
import { describeError, retryTransient } from '../evidence/api';

export const adminToolsKeys = {
  all: ['admin', 'admin-tools'] as const,
  settings: () => ['admin', 'admin-tools', 'settings'] as const,
  status: () => ['admin', 'admin-tools', 'status'] as const,
  guild: () => ['admin', 'admin-tools', 'guild'] as const,
  /** Feature tabs key their own queries under this prefix, e.g. adminToolsKeys.feature('members', query). */
  feature: (area: string, ...rest: unknown[]) => ['admin', 'admin-tools', area, ...rest] as const
};

/** True when the runtime mounts the admin tools and this session may at least read them. */
export function useAdminToolsAccess(): boolean {
  const session = useSession();
  return session.session?.adminTools === true && session.hasCapability('members.read');
}

/** True when the admin tools are mounted and the session holds `capability`. */
export function useAdminToolsCapability(capability: Capability): boolean {
  const session = useSession();
  return session.session?.adminTools === true && session.hasCapability(capability);
}

export const getAdminToolsSettings = (api: ApiClient, signal?: AbortSignal) =>
  api.request<AdminToolsSettingsDto>('GET', '/admin-tools/settings', signal ? { signal } : {});
export const getAdminToolsStatus = (api: ApiClient, signal?: AbortSignal) =>
  api.request<AdminToolsStatusDto>('GET', '/admin-tools/status', signal ? { signal } : {});
export const getGuildMeta = (api: ApiClient, signal?: AbortSignal) =>
  api.request<GuildMetaDto>('GET', '/admin-tools/guild', signal ? { signal } : {});

export type SaveAdminToolsResult =
  | { ok: true; settings: AdminToolsSettingsDto }
  | { ok: false; conflict: AdminToolsSettingsDto; message: string };

/** PUT with optimistic concurrency; a 409 resolves with the server's current state instead of throwing. */
export async function saveAdminToolsSettings(api: ApiClient, expectedVersion: number,
  settings: AdminToolsSettingsBodyDto): Promise<SaveAdminToolsResult> {
  try {
    const saved = await api.request<AdminToolsSettingsDto>('PUT', '/admin-tools/settings', { body: { expectedVersion, settings } });
    return { ok: true, settings: saved };
  } catch (error) {
    const body = error instanceof ApiError && error.status === 409 ? error.body as Partial<AdminToolsSettingsConflictDto> | null : null;
    if (body?.current) return { ok: false, conflict: body.current, message: error instanceof Error ? error.message : 'Conflict' };
    throw error;
  }
}

export function adminToolsBodyOf(settings: AdminToolsSettingsDto): AdminToolsSettingsBodyDto {
  const { cases, tickets, logging } = settings;
  return { cases, tickets, logging };
}

export function useAdminToolsSettings() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: adminToolsKeys.settings(), queryFn: ({ signal }) => getAdminToolsSettings(api, signal),
    enabled: access, staleTime: 30_000, retry: retryTransient });
}

export function useAdminToolsStatus() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: adminToolsKeys.status(), queryFn: ({ signal }) => getAdminToolsStatus(api, signal),
    enabled: access, staleTime: 15_000, refetchInterval: 60_000, retry: retryTransient });
}

/** Roles, channels (with `reserved` marks) and emojis for pickers. */
export function useGuildMeta() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: adminToolsKeys.guild(), queryFn: ({ signal }) => getGuildMeta(api, signal),
    enabled: access, staleTime: 60_000, retry: retryTransient });
}

export interface AdminToolsSectionEditor<K extends AdminToolsSettingsSection> {
  /** Server state; undefined while loading. */
  saved: AdminToolsSettingsDto | undefined;
  /** The draft when edited, else the saved section. */
  value: AdminToolsSettingsBodyDto[K] | undefined;
  setValue(next: AdminToolsSettingsBodyDto[K]): void;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  loadError: unknown;
  saveError: string | null;
  /** Someone saved first: the latest server state is shown and the admin's edits wait in a stash. */
  conflict: boolean;
  reapply(): void;
  discardStash(): void;
  reset(): void;
  /** Saves only this section on top of the latest saved document. Resolves true when saved. */
  save(): Promise<boolean>;
}

/**
 * Edits one section of the shared settings document. Each tab owns its section; saving sends the whole
 * document with only this section replaced, so tabs never overwrite each other's saved sections.
 */
export function useAdminToolsSection<K extends AdminToolsSettingsSection>(section: K): AdminToolsSectionEditor<K> {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const query = useAdminToolsSettings();
  const [draft, setDraft] = useState<AdminToolsSettingsBodyDto[K] | null>(null);
  const [stash, setStash] = useState<AdminToolsSettingsBodyDto[K] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saved = query.data;
  const value = draft ?? saved?.[section];
  const dirty = draft !== null && !!saved && JSON.stringify(draft) !== JSON.stringify(saved[section]);

  const save = useCallback(async () => {
    if (!saved || draft === null || saving) return false;
    setSaving(true); setSaveError(null);
    try {
      const result = await saveAdminToolsSettings(api, saved.version, { ...adminToolsBodyOf(saved), [section]: draft });
      if (result.ok) {
        queryClient.setQueryData(adminToolsKeys.settings(), result.settings);
        setDraft(null); setStash(null);
        void queryClient.invalidateQueries({ queryKey: adminToolsKeys.status() });
        return true;
      }
      queryClient.setQueryData(adminToolsKeys.settings(), result.conflict);
      setStash(draft); setDraft(null);
      return false;
    } catch (cause) {
      setSaveError(describeError(cause, 'Settings could not be saved.'));
      return false;
    } finally { setSaving(false); }
  }, [api, draft, queryClient, saved, saving, section]);

  return {
    saved, value, dirty, saving, saveError,
    loading: query.isPending, loadError: query.error,
    setValue: next => { setDraft(next); setSaveError(null); },
    conflict: stash !== null,
    reapply: () => { if (stash !== null) { setDraft(stash); setStash(null); } },
    discardStash: () => setStash(null),
    reset: () => { setDraft(null); setSaveError(null); },
    save
  };
}
