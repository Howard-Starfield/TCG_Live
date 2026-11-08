import { useQuery } from '@tanstack/react-query';
import { useAdminData } from '../../data';

export const tournamentDirectoryKey = ['tournaments'] as const;

/** The server owns directory search and order; each query uses its own abortable cache entry. */
export function useTournamentDirectory(query: string, enabled: boolean) {
  const { api } = useAdminData();
  return useQuery({
    queryKey: [...tournamentDirectoryKey, query],
    queryFn: ({ signal }) => api.listTournaments(query, signal),
    enabled
  });
}
