// Test helpers for the List preview tests (not used by production code).
import type { EventSnapshotDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { render, screen, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { useState } from 'react';
import { vi } from 'vitest';
import { AdminDataProvider } from '../../data';
import { createFixtureData, type FixtureDataOptions } from './fixtureData';
import { ListPreview, type ListTab } from './index';

MotionGlobalConfig.skipAnimations = true;

export function renderList(snapshot: EventSnapshotDto, initialTab: ListTab,
  options: Omit<FixtureDataOptions, 'snapshot'> & { withOpenMatch?: boolean } = {}) {
  const { withOpenMatch = true, ...dataOptions } = options;
  const fixture = createFixtureData({ snapshot, localNow: () => FIXTURE_NOW_MS, ...dataOptions });
  const onTabChange = vi.fn();
  const onOpenMatch = vi.fn();
  function Harness() {
    const [tab, setTab] = useState<ListTab>(initialTab);
    return (
      <ListPreview snapshot={snapshot} tab={tab}
        onTabChange={next => { onTabChange(next); setTab(next); }}
        {...(withOpenMatch ? { onOpenMatch } : {})} />
    );
  }
  const view = render(<AdminDataProvider data={fixture.data}><Harness /></AdminDataProvider>);
  return { ...view, fixture, onTabChange, onOpenMatch };
}

/** Body rows of the table with this accessible name (caption). */
export function bodyRows(name: string | RegExp): HTMLElement[] {
  const table = screen.getByRole('table', { name });
  return within(table).getAllByRole('row').slice(1);
}
