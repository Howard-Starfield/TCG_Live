// LFG tab data: versioned settings (409 shows the fresh state), posts with filters, stats and panel status, plus
// the same template checks the server runs (placeholders and Discord limits with the longest possible values).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LFG_LIMITS as L, lfgWorstCaseLength, unknownLfgPlaceholders, type LfgPanelDto, type LfgPanelListDto,
  type LfgPostDto, type LfgPostListDto, type LfgPostStatus, type LfgSettingsBodyDto, type LfgSettingsConflictDto, type LfgSettingsDto,
  type LfgStatsDto } from '@tcg-live/core';
import { ApiError, useAdminData, type ApiClient } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export type LfgPostFilter = LfgPostStatus | 'active' | 'all';

export const lfgKeys = {
  settings: () => adminToolsKeys.feature('lfg', 'settings'),
  posts: (status: LfgPostFilter, game: string | null) => adminToolsKeys.feature('lfg', 'posts', status, game),
  allPosts: () => adminToolsKeys.feature('lfg', 'posts'),
  stats: (days: number) => adminToolsKeys.feature('lfg', 'stats', days),
  panels: () => adminToolsKeys.feature('lfg', 'panels')
};

export function lfgBodyOf(settings: LfgSettingsDto): LfgSettingsBodyDto {
  const { guildId: _g, version: _v, updatedAtMs: _u, ...body } = settings;
  return body;
}

export type SaveLfgResult = { ok: true; settings: LfgSettingsDto } | { ok: false; conflict: LfgSettingsDto };
export async function saveLfgSettings(api: ApiClient, expectedVersion: number, settings: LfgSettingsBodyDto): Promise<SaveLfgResult> {
  try {
    return { ok: true, settings: await api.request<LfgSettingsDto>('PUT', '/admin-tools/lfg/settings', { body: { expectedVersion, settings } }) };
  } catch (error) {
    const body = error instanceof ApiError && error.status === 409 ? error.body as Partial<LfgSettingsConflictDto> | null : null;
    if (body?.current) return { ok: false, conflict: body.current };
    throw error;
  }
}

export function useLfgSettings() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: lfgKeys.settings(), enabled: access, staleTime: 30_000, retry: retryTransient,
    queryFn: ({ signal }) => api.request<LfgSettingsDto>('GET', '/admin-tools/lfg/settings', signal ? { signal } : {}) });
}

export function useLfgPosts(status: LfgPostFilter, game: string | null) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  const params = new URLSearchParams({ limit: '100' });
  if (status !== 'all') params.set('status', status);
  if (game) params.set('game', game);
  return useQuery({ queryKey: lfgKeys.posts(status, game), enabled: access, retry: retryTransient, refetchInterval: 30_000,
    queryFn: ({ signal }) => api.request<LfgPostListDto>('GET', `/admin-tools/lfg/posts?${params.toString()}`, signal ? { signal } : {}) });
}

export function useLfgStats(days: number) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: lfgKeys.stats(days), enabled: access, retry: retryTransient,
    queryFn: ({ signal }) => api.request<LfgStatsDto>('GET', `/admin-tools/lfg/stats?days=${days}`, signal ? { signal } : {}) });
}

export function useLfgPanels() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: lfgKeys.panels(), enabled: access, retry: retryTransient, refetchInterval: 60_000,
    queryFn: ({ signal }) => api.request<LfgPanelListDto>('GET', '/admin-tools/lfg/panels', signal ? { signal } : {}) });
}

export function useLfgPostMutations() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const onSettled = () => { void queryClient.invalidateQueries({ queryKey: adminToolsKeys.feature('lfg') }); };
  return {
    close: useMutation({ onSettled, mutationFn: (id: string) => api.request<LfgPostDto>('POST', `/admin-tools/lfg/posts/${id}/close`) }),
    remove: useMutation({ onSettled, mutationFn: (id: string) => api.request<LfgPostDto>('DELETE', `/admin-tools/lfg/posts/${id}`) }),
    refreshPanels: useMutation({ onSettled, mutationFn: () => api.request<LfgPanelListDto>('POST', '/admin-tools/lfg/panels/refresh') })
  };
}

const len = (value: string) => [...value].length;

function panelProblems(panel: LfgPanelDto, label: string): string[] {
  const out: string[] = [];
  if (!panel.title.trim() || len(panel.title) > L.panelTitleLength) out.push(`${label}: the title needs 1-${L.panelTitleLength} characters.`);
  if (!panel.text.trim() || len(panel.text) > L.panelTextLength) out.push(`${label}: the text needs 1-${L.panelTextLength} characters.`);
  if (!panel.buttonLabel.trim() || len(panel.buttonLabel) > L.buttonLabelLength) out.push(`${label}: the button label needs 1-${L.buttonLabelLength} characters.`);
  return out;
}

/** Everything the server would refuse, in plain words (the server checks again). */
export function lfgSettingsProblems(value: LfgSettingsBodyDto): string[] {
  const out: string[] = [];
  const lists = { games: value.games, formats: value.formats };
  if (value.enabled && !value.channels.length) out.push('Choose at least one LFG channel before turning LFG on.');
  if (value.channels.some(channel => !channel.channelId)) out.push('Every LFG channel row needs a channel.');
  if (new Set(value.channels.map(channel => channel.channelId)).size !== value.channels.length) out.push('Each LFG channel can be listed once.');
  if (value.games.some(game => !game.name.trim() || len(game.name) > L.gameNameLength || /[{}]/.test(game.name)))
    out.push(`Every game needs a name of 1-${L.gameNameLength} characters without { }.`);
  if (new Set(value.games.map(game => game.name.trim().toLowerCase())).size !== value.games.length) out.push('Each game can be listed once.');
  if (value.formats.some(format => !format.trim() || len(format) > L.formatLength)) out.push(`Formats need 1-${L.formatLength} characters.`);
  out.push(...panelProblems(value.panel, 'Panel'));
  for (const [index, channel] of value.channels.entries()) if (channel.panel) out.push(...panelProblems(channel.panel, `Channel ${index + 1} panel`));
  for (const [key, text] of Object.entries(value.form)) {
    const max = key === 'title' ? L.modalTitleLength : key.endsWith('Label') ? L.modalLabelLength : L.modalPlaceholderLength;
    if (!text.trim() || len(text) > max) out.push(`Form ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}: 1-${max} characters.`);
  }
  const m = value.messages;
  const templates: Array<[string, string, number, number, boolean]> = [
    ['Card title', m.cardTitle, L.cardTitleLength, L.cardTitleLength, false], ['Card text', m.cardBody, L.cardTemplateLength, L.cardBodyLength, false],
    ['Closed text', m.closedText, L.cardTemplateLength, L.cardBodyLength, false], ['Expired text', m.expiredText, L.cardTemplateLength, L.cardBodyLength, false],
    ['Posted reply', m.postedText, L.replyLength, L.contentLength, false], ['Joined reply', m.joinedText, L.replyLength, L.contentLength, false],
    ['Left reply', m.leftText, L.replyLength, L.contentLength, false], ['Ping text', m.pingText, L.pingLength, L.contentLength, true]];
  for (const [label, text, max, limit, role] of templates) {
    if (!text.trim() || len(text) > max) { out.push(`${label} needs 1-${max} characters.`); continue; }
    const unknown = unknownLfgPlaceholders(text, role);
    if (unknown.length) out.push(`${label} uses unknown placeholders: ${unknown.map(item => `{${item}}`).join(', ')}.`);
    const worst = lfgWorstCaseLength(text, lists);
    if (worst > limit) out.push(`${label} can reach ${worst} characters with long names and notes; Discord allows ${limit}.`);
  }
  if (/\n/.test(m.cardTitle)) out.push('Card title must be one line.');
  if (!m.pingText.includes('{role}')) out.push('Ping text must contain {role}.');
  for (const [label, text] of [['Join', m.joinLabel], ['Leave', m.leaveLabel], ['Close', m.closeLabel]] as const)
    if (!text.trim() || len(text) > L.buttonLabelLength) out.push(`${label} button label needs 1-${L.buttonLabelLength} characters.`);
  return out;
}
