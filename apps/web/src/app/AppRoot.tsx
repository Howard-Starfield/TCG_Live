import type { ReactNode } from 'react';
import { AdminDataProvider, preferencesStore, type AdminData, type PreferencesStore } from '../data';
import { ThemeProvider, ToastProvider } from '../ui';
import { FragmentLogin } from './FragmentLogin';
import { PreferencesScope, useConsolePreferences } from './preferences';
import { SessionGate } from './SessionGate';

export interface AppRootProps {
  /** Created once, outside render. */
  data: AdminData;
  /** Defaults to the browser-wide preferences store. */
  preferences?: PreferencesStore;
}

/** Providers (data, preferences, theme, toasts) around the session gate. */
export function AppRoot({ data, preferences = preferencesStore }: AppRootProps) {
  return (
    <AdminDataProvider data={data}>
      <PreferencesScope store={preferences}>
        <ThemedApp>
          <ToastProvider>
            <FragmentLogin />
            <SessionGate />
          </ToastProvider>
        </ThemedApp>
      </PreferencesScope>
    </AdminDataProvider>
  );
}

function ThemedApp({ children }: { children: ReactNode }) {
  const [preferences] = useConsolePreferences();
  return <ThemeProvider theme={preferences.theme}>{children}</ThemeProvider>;
}
