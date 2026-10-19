// The preferences store in scope. The app uses the browser-wide store; tests inject an in-memory one.
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { preferencesStore, usePreferences, type Preferences, type PreferencesPatch,
  type PreferencesStore } from '../data';

const PreferencesContext = createContext<PreferencesStore>(preferencesStore);

export function PreferencesScope({ store, children }: { store: PreferencesStore; children: ReactNode }) {
  return <PreferencesContext.Provider value={store}>{children}</PreferencesContext.Provider>;
}

/** Current preferences and an updater, both bound to the store in scope. */
export function useConsolePreferences(): [Preferences, (patch: PreferencesPatch | ((current: Preferences) => PreferencesPatch)) => void] {
  const store = useContext(PreferencesContext);
  const preferences = usePreferences(store);
  const update = useCallback((patch: PreferencesPatch | ((current: Preferences) => PreferencesPatch)) => store.update(patch), [store]);
  return [preferences, update];
}
