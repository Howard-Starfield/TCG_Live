import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { AdminDataContext, type AdminData } from './admin-data';
import { ServerClockContext } from './clock';

/**
 * Provides the data layer (AdminData, its QueryClient and server clock) and runs `data.start()` while
 * mounted. Create `data` once, outside render (for example at module scope in main.tsx).
 */
export function AdminDataProvider({ data, children }: { data: AdminData; children?: ReactNode }) {
  useEffect(() => {
    data.start();
    return () => data.stop();
  }, [data]);

  return (
    <AdminDataContext.Provider value={data}>
      <ServerClockContext.Provider value={data.clock}>
        <QueryClientProvider client={data.queryClient}>{children}</QueryClientProvider>
      </ServerClockContext.Provider>
    </AdminDataContext.Provider>
  );
}
