// Announcements data: history list and save/send/delete mutations. The wire types mirror the server's
// feature-local AnnouncementViewDto / SaveAnnouncementExtDto (apps/server/src/admin-tools/announcements/types.ts).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnnouncementDto, SaveAnnouncementRequestDto } from '@tcg-live/core';
import { useAdminData } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export interface AnnouncementView extends AnnouncementDto { mentionEveryone: boolean; missed: boolean }
export interface SaveAnnouncementBody extends SaveAnnouncementRequestDto { mentionEveryone?: boolean; draft?: boolean }
export interface AnnouncementList { announcements: AnnouncementView[] }

export const announcementKeys = { list: () => adminToolsKeys.feature('announcements', 'list') };

export function useAnnouncements() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: announcementKeys.list(), enabled: access, staleTime: 10_000, refetchInterval: 30_000, retry: retryTransient,
    queryFn: ({ signal }) => api.request<AnnouncementList>('GET', '/admin-tools/announcements', signal ? { signal } : {}) });
}

export function useAnnouncementMutations() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const onSettled = () => { void queryClient.invalidateQueries({ queryKey: announcementKeys.list() }); };
  return {
    save: useMutation({ onSettled, mutationFn: ({ id, body }: { id: string | null; body: SaveAnnouncementBody }) =>
      id ? api.request<AnnouncementView>('PUT', `/admin-tools/announcements/${id}`, { body })
        : api.request<AnnouncementView>('POST', '/admin-tools/announcements', { body }) }),
    send: useMutation({ onSettled, mutationFn: (id: string) => api.request<AnnouncementView>('POST', `/admin-tools/announcements/${id}/send`) }),
    remove: useMutation({ onSettled, mutationFn: (id: string) =>
      api.request<{ deleted: boolean; messageDeleted: boolean }>('DELETE', `/admin-tools/announcements/${id}`) })
  };
}
