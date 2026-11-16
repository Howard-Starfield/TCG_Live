// Tournament roles (TCG Organizer, TCG Judge): the Settings card's queries and mutations, plus the colour helpers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DISCORD_ROLE_COLOR_PRESETS, type TournamentRoleEditDto, type TournamentRoleKind, type TournamentRolesDto,
  type TournamentRolesEnsureResultDto } from '@tcg-live/core';
import { useAdminData, type ApiClient } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export const tournamentRolesKeys = { all: () => adminToolsKeys.feature('tournament-roles') };

const BASE = '/admin-tools/tournament-roles';
export const getTournamentRoles = (api: ApiClient, signal?: AbortSignal) =>
  api.request<TournamentRolesDto>('GET', BASE, signal ? { signal } : {});

/** Names for DISCORD_ROLE_COLOR_PRESETS, in the same order (Discord's own swatch names). */
const PRESET_NAMES = ['Teal', 'Green', 'Blue', 'Purple', 'Magenta', 'Yellow', 'Orange', 'Red', 'Light grey', 'Dark grey',
  'Dark teal', 'Dark green', 'Dark blue', 'Dark purple', 'Dark magenta', 'Dark gold', 'Dark orange', 'Dark red', 'Grey', 'Darker grey'];

/** `#E67E22`. */
export const colorHex = (color: number): string => `#${color.toString(16).padStart(6, '0').toUpperCase()}`;

/** The accessible name of a swatch: Discord's colour name, or the hex when the preset list has no name for it. */
export function presetName(color: number): string {
  const index = DISCORD_ROLE_COLOR_PRESETS.indexOf(color);
  return PRESET_NAMES[index] && PRESET_NAMES.length === DISCORD_ROLE_COLOR_PRESETS.length ? PRESET_NAMES[index]! : colorHex(color);
}

/** Six hex digits with an optional leading #; null when it is not a colour. */
export function parseHexColor(text: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match ? parseInt(match[1]!, 16) : null;
}

export function useTournamentRoles() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: tournamentRolesKeys.all(), queryFn: ({ signal }) => getTournamentRoles(api, signal),
    enabled: access, staleTime: 15_000, retry: retryTransient });
}

/** Every change re-reads the roles (the server owns names, colours and who holds what). */
export function useTournamentRoleMutations() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const settle = () => { void queryClient.invalidateQueries({ queryKey: tournamentRolesKeys.all() }); };
  const ensure = useMutation({ onSettled: settle,
    mutationFn: () => api.request<TournamentRolesEnsureResultDto>('POST', `${BASE}/ensure`, { body: {} }) });
  const edit = useMutation({ onSettled: settle,
    mutationFn: ({ kind, ...body }: { kind: TournamentRoleKind } & TournamentRoleEditDto) =>
      api.request<unknown>('PATCH', `${BASE}/${kind}`, { body }) });
  const addMember = useMutation({ onSettled: settle,
    mutationFn: ({ kind, userId }: { kind: TournamentRoleKind; userId: string }) =>
      api.request<unknown>('PUT', `${BASE}/${kind}/members/${userId}`) });
  const removeMember = useMutation({ onSettled: settle,
    mutationFn: ({ kind, userId }: { kind: TournamentRoleKind; userId: string }) =>
      api.request<unknown>('DELETE', `${BASE}/${kind}/members/${userId}`) });
  return { ensure, edit, addMember, removeMember };
}
