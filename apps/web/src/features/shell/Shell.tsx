import type { SessionDto } from '@tcg-live/core';
import { useEffect, useState } from 'react';
import { CommandsProvider } from '../commands';
import { MainControls } from '../console';
import { useConsolePreferences } from '../../app/preferences';
import { Banners } from './Banners';
import { ShellProvider, useShellModel } from './model';
import { PreviewDock, PreviewSheet } from './PreviewDock';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useAltDigitShortcuts } from './useShortcuts';
import { DraftDetails } from '../tournaments/DraftDetails';
import { Home } from './Home';

/** Width of an element, kept current with ResizeObserver. */
function useElementWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return;
    setWidth(node.getBoundingClientRect().width || node.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}

/** The signed-in console: sidebar, top bar, banners, main controls and the preview dock. */
export function Shell({ session }: { session: SessionDto }) {
  const model = useShellModel(session);
  const [preferences] = useConsolePreferences();
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useElementWidth(body);

  const eventView = !model.draft && !model.home;
  useAltDigitShortcuts({ 1: () => { if (eventView) model.dock.toggle('live'); },
    2: () => { if (eventView) model.dock.toggle('list'); } });

  return (
    <ShellProvider value={model}>
      {/* Wave 3: admin actions; every slot stays empty unless the session reports commandsEnabled. */}
      <CommandsProvider session={session}>
        <div className="shell" data-sidebar={preferences.sidebarCollapsed ? 'collapsed' : 'expanded'}
          data-narrow={model.dock.narrow || undefined}>
          <Sidebar />
          <div className="shell-workspace">
            <TopBar />
            <Banners />
            <div ref={setBody} className="shell-body">
              <main className="shell-main" aria-label="Console">
                {model.home ? <Home /> : model.draft ? <DraftDetails key={model.draft.eventId} draft={model.draft} /> : <MainControls />}
              </main>
              {eventView && <PreviewDock bodyWidth={bodyWidth} />}
            </div>
          </div>
          {eventView && <PreviewSheet />}
        </div>
      </CommandsProvider>
    </ShellProvider>
  );
}
