import { useQuery } from '@tanstack/react-query';
import { useActiveEventId, useAdminData } from '../../data';

export const tournamentDirectoryKey = ['tournaments'] as const;

/** The server owns directory search and order; each query uses its own abortable cache entry. */
export function useTournamentDirectory(query: string, enabled: boolean) {
  const { api } = useAdminData();
  const activeEventId = useActiveEventId();
  return useQuery({
    queryKey: [...tournamentDirectoryKey, activeEventId, query],
    queryFn: ({ signal }) => api.listTournaments(query, signal),
    enabled
  });
}
