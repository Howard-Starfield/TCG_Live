import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, PreferencesStore, sanitizePreferences, usePreferences } from './preferences';
import { createMemoryStorage } from './storage';

describe('preferences', () => {
  it('starts from defaults with empty storage', () => {
    const store = new PreferencesStore(createMemoryStorage(), null);
    expect(store.getSnapshot()).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back to defaults on corrupt JSON and per field on invalid values', () => {
    const storage = createMemoryStorage();
    storage.setItem(PREFERENCES_KEY, '{not json');
    expect(new PreferencesStore(storage, null).getSnapshot()).toEqual(DEFAULT_PREFERENCES);

    storage.setItem(PREFERENCES_KEY, JSON.stringify({ panes: { live: false, list: 'yes' },
      sizes: { dockWidth: 99_999, split: Number.NaN }, theme: 'neon', listTab: 'audit', sidebarCollapsed: 1 }));
    expect(new PreferencesStore(storage, null).getSnapshot()).toEqual({
      ...DEFAULT_PREFERENCES,
      panes: { live: false, list: false },
      sizes: { dockWidth: 1600, split: 0.5 },
      listTab: 'audit'
    });
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences([1, 2])).toEqual(DEFAULT_PREFERENCES);
  });

  it('merges nested patches, persists them and keeps the snapshot stable', () => {
    const storage = createMemoryStorage();
    const store = new PreferencesStore(storage, null);
    const before = store.getSnapshot();
    store.update({ panes: { list: true } });
    store.update(current => ({ sizes: { split: current.sizes.split - 0.2 } }));
    const after = store.getSnapshot();
    expect(after.panes).toEqual({ live: true, list: true });
    expect(after.sizes.split).toBeCloseTo(0.3);
    expect(JSON.parse(storage.getItem(PREFERENCES_KEY)!)).toEqual(after);
    store.update({ theme: after.theme });
    expect(store.getSnapshot()).toBe(after);           // no-op updates keep the reference
    expect(before).toBe(DEFAULT_PREFERENCES);
  });

  it('keeps working when storage writes throw', () => {
    const store = new PreferencesStore({ getItem: () => null, setItem: () => { throw new Error('quota'); },
      removeItem: () => {} }, null);
    store.update({ theme: 'dark' });
    expect(store.getSnapshot().theme).toBe('dark');
  });

  it('syncs across tabs through storage events', () => {
    const storage = createMemoryStorage();
    const target = new EventTarget();
    const store = new PreferencesStore(storage, target);
    const { result } = renderHook(() => usePreferences(store));
    expect(result.current.theme).toBe('system');

    // Another tab writes and the browser fires a storage event here.
    storage.setItem(PREFERENCES_KEY, JSON.stringify({ ...DEFAULT_PREFERENCES, theme: 'dark', canvasView: 'match' }));
    act(() => { target.dispatchEvent(Object.assign(new Event('storage'), { key: PREFERENCES_KEY })); });
    expect(result.current).toMatchObject({ theme: 'dark', canvasView: 'match' });

    // Unrelated keys are ignored; a clear() (key null) falls back to defaults.
    act(() => { target.dispatchEvent(Object.assign(new Event('storage'), { key: 'other' })); });
    expect(result.current.theme).toBe('dark');
    storage.removeItem(PREFERENCES_KEY);
    act(() => { target.dispatchEvent(Object.assign(new Event('storage'), { key: null })); });
    expect(result.current).toEqual(DEFAULT_PREFERENCES);
  });

  it('re-renders subscribers on local updates', () => {
    const store = new PreferencesStore(createMemoryStorage(), null);
    const { result } = renderHook(() => usePreferences(store));
    act(() => store.update({ sidebarCollapsed: true, listTab: 'panels' }));
    expect(result.current).toMatchObject({ sidebarCollapsed: true, listTab: 'panels' });
  });
});
