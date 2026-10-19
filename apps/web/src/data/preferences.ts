import { useSyncExternalStore } from 'react';
import { browserLocalStorage, safeStorage, type KeyValueStorage } from './storage';

/** Versioned localStorage key; a breaking shape change gets a new key rather than a migration. */
export const PREFERENCES_KEY = 'tcg-admin.prefs.v1';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ListTab = 'players' | 'matches' | 'audit' | 'panels';
export type CanvasView = 'event' | 'match';

/** Console layout and display preferences, persisted per browser. */
export interface Preferences {
  /** Which preview panes are open in the dock. */
  panes: { live: boolean; list: boolean };
  /** Dock width in px, and the live/list split ratio (live share, 0–1). */
  sizes: { dockWidth: number; split: number };
  sidebarCollapsed: boolean;
  theme: ThemePreference;
  listTab: ListTab;
  canvasView: CanvasView;
}

/** A partial update; `panes` and `sizes` merge field by field. */
export type PreferencesPatch = Partial<Omit<Preferences, 'panes' | 'sizes'>> & {
  panes?: Partial<Preferences['panes']>;
  sizes?: Partial<Preferences['sizes']>;
};

export const DOCK_WIDTH_MIN = 280;
export const DOCK_WIDTH_MAX = 1600;
export const SPLIT_MIN = 0.1;
export const SPLIT_MAX = 0.9;

/** Defaults: live preview open, list closed, a 480 px dock split evenly, system theme. */
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  panes: Object.freeze({ live: true, list: false }),
  sizes: Object.freeze({ dockWidth: 480, split: 0.5 }),
  sidebarCollapsed: false,
  theme: 'system',
  listTab: 'players',
  canvasView: 'event'
}) as Preferences;

const THEMES: readonly ThemePreference[] = ['light', 'dark', 'system'];
const LIST_TABS: readonly ListTab[] = ['players', 'matches', 'audit', 'panels'];
const CANVAS_VIEWS: readonly CanvasView[] = ['event', 'match'];

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  (typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback);
const clamped = (value: unknown, min: number, max: number, fallback: number) =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** Validates any value into Preferences, field by field, falling back to defaults. */
export function sanitizePreferences(value: unknown): Preferences {
  const root = record(value) ?? {};
  const panes = record(root.panes) ?? {};
  const sizes = record(root.sizes) ?? {};
  const d = DEFAULT_PREFERENCES;
  return {
    panes: { live: bool(panes.live, d.panes.live), list: bool(panes.list, d.panes.list) },
    sizes: {
      dockWidth: Math.round(clamped(sizes.dockWidth, DOCK_WIDTH_MIN, DOCK_WIDTH_MAX, d.sizes.dockWidth)),
      split: clamped(sizes.split, SPLIT_MIN, SPLIT_MAX, d.sizes.split)
    },
    sidebarCollapsed: bool(root.sidebarCollapsed, d.sidebarCollapsed),
    theme: oneOf(root.theme, THEMES, d.theme),
    listTab: oneOf(root.listTab, LIST_TABS, d.listTab),
    canvasView: oneOf(root.canvasView, CANVAS_VIEWS, d.canvasView)
  };
}

function parse(raw: string | null): Preferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  try {
    return sanitizePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function equal(a: Preferences, b: Preferences): boolean {
  return a.panes.live === b.panes.live && a.panes.list === b.panes.list
    && a.sizes.dockWidth === b.sizes.dockWidth && a.sizes.split === b.sizes.split
    && a.sidebarCollapsed === b.sidebarCollapsed && a.theme === b.theme
    && a.listTab === b.listTab && a.canvasView === b.canvasView;
}

/** An external store over localStorage, synced across tabs through `storage` events. */
export class PreferencesStore {
  private current: Preferences;
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  private readonly storage: KeyValueStorage;

  constructor(
    storage: KeyValueStorage = browserLocalStorage(),
    private readonly eventTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null =
      typeof window === 'undefined' ? null : window
  ) {
    this.storage = safeStorage(storage);   // quota or disabled storage never breaks the UI
    this.current = parse(this.storage.getItem(PREFERENCES_KEY));
  }

  /** Current preferences (stable reference until they change). */
  readonly getSnapshot = (): Preferences => this.current;

  /** Subscribes; the cross-tab listener is attached while anyone listens. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach && this.eventTarget) {
      const target = this.eventTarget;
      const onStorage = (event: Event) => {
        const key = (event as StorageEvent).key;
        if (key === PREFERENCES_KEY || key === null) this.reload();   // null: storage.clear()
      };
      target.addEventListener('storage', onStorage);
      this.detach = () => target.removeEventListener('storage', onStorage);
      this.reload();   // catch up on writes made while nobody was listening
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.detach?.();
        this.detach = null;
      }
    };
  };

  /** Applies a patch (or an updater) and persists it. */
  readonly update = (patch: PreferencesPatch | ((current: Preferences) => PreferencesPatch)): void => {
    const delta = typeof patch === 'function' ? patch(this.current) : patch;
    const next = sanitizePreferences({
      ...this.current, ...delta,
      panes: { ...this.current.panes, ...delta.panes },
      sizes: { ...this.current.sizes, ...delta.sizes }
    });
    if (equal(next, this.current)) return;
    this.storage.setItem(PREFERENCES_KEY, JSON.stringify(next));
    this.set(next);
  };

  /** Restores the defaults. */
  readonly reset = (): void => {
    this.storage.removeItem(PREFERENCES_KEY);
    this.set(DEFAULT_PREFERENCES);
  };

  /** Re-reads storage (another tab wrote it). */
  reload(): void {
    const next = parse(this.storage.getItem(PREFERENCES_KEY));
    if (!equal(next, this.current)) this.set(next);
  }

  private set(next: Preferences): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The app-wide preferences store. */
export const preferencesStore = new PreferencesStore();

/** Updates the app-wide preferences: `updatePreferences({ panes: { list: true } })`. */
export const updatePreferences = preferencesStore.update;

/** Restores the app-wide preferences to their defaults. */
export const resetPreferences = preferencesStore.reset;

/** Current preferences; re-renders on change, including changes from other tabs. */
export function usePreferences(store: PreferencesStore = preferencesStore): Preferences {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => DEFAULT_PREFERENCES);
}
