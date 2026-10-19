import { CalendarX, DatabaseZap, LoaderCircle, Table2, Workflow, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useServerClock } from '../../data';
import { LivePreview } from '../flow';
import { ListPreview } from '../lists';
import { Button, EmptyState, IconButton, PaneHeader, SplitPane, focusableWithin, springs, useSafeTransition, useSafeVariants, variants } from '../../ui';
import { useConsolePreferences } from '../../app/preferences';
import { useShell } from './model';

export const DOCK_MIN = 320;
export const DOCK_DEFAULT = 480;
/** The main controls keep at least this much width beside the dock. */
export const MAIN_MIN = 440;

/** Largest dock width that leaves the main controls usable. */
export function maxDockWidth(bodyWidth: number): number {
  return Math.max(DOCK_MIN, bodyWidth - MAIN_MIN);
}

export function clampDockWidth(width: number, bodyWidth: number): number {
  return Math.round(Math.min(maxDockWidth(bodyWidth), Math.max(DOCK_MIN, width)));
}

/** The desktop dock: a resizable column on the right of the workspace body. */
export function PreviewDock({ bodyWidth }: { bodyWidth: number }) {
  const { dock } = useShell();
  const [preferences, update] = useConsolePreferences();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const spring = useSafeTransition(springs.pane);
  const open = !dock.narrow && (dock.visible.live || dock.visible.list);
  const width = clampDockWidth(dragWidth ?? preferences.sizes.dockWidth, bodyWidth || 1440);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside key="dock" aria-label="Previews" className="shell-dock" data-testid="preview-dock"
          initial={{ width: 0, opacity: 0 }} animate={{ width, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
          transition={dragWidth !== null ? { duration: 0 } : spring}>
          <DockResizeHandle width={width} bodyWidth={bodyWidth}
            onDrag={setDragWidth}
            onCommit={next => { setDragWidth(null); update({ sizes: { dockWidth: next } }); }} />
          <div className="shell-dock-inner" style={{ width }}>
            <DockPanes />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** Vertical divider on the dock's left edge: drag, arrow keys, Home/End, double-click or Enter to reset. */
function DockResizeHandle({ width, bodyWidth, onDrag, onCommit }: {
  width: number; bodyWidth: number; onDrag(width: number | null): void; onCommit(width: number): void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; current: number; active: boolean } | null>(null);
  const clamp = (value: number) => clampDockWidth(value, bodyWidth);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, current: width, active: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = state.startX - event.clientX;
    if (!state.active && Math.abs(delta) < 4) return;
    state.active = true;
    state.current = clamp(state.startWidth + delta);
    onDrag(state.current);
  };
  const end = (commit: boolean) => {
    const state = drag.current;
    drag.current = null;
    if (!state?.active) return;
    if (commit) onCommit(state.current);
    else onDrag(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = maxDockWidth(bodyWidth);
    else if (event.key === 'End') next = DOCK_MIN;
    else if (event.key === 'Enter') next = DOCK_DEFAULT;
    else if (event.key === 'Escape' && drag.current) { event.preventDefault(); end(false); return; }
    if (next === null) return;
    event.preventDefault();
    onCommit(clamp(next));
  };

  return (
    <div role="separator" tabIndex={0} aria-label="Resize previews" aria-orientation="vertical"
      aria-valuenow={width} aria-valuemin={DOCK_MIN} aria-valuemax={maxDockWidth(bodyWidth)} aria-valuetext={`${width} pixels wide`}
      title="Drag to resize; double-click to reset" className="shell-dock-handle"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => end(true)} onPointerCancel={() => end(false)}
      onDoubleClick={() => onCommit(clamp(DOCK_DEFAULT))} onKeyDown={onKeyDown} />
  );
}

/** Below 1100 px: the previews as a dismissible, focus-trapping overlay sheet. */
export function PreviewSheet() {
  const { dock } = useShell();
  const backdrop = useSafeVariants(variants.backdrop);
  const spring = useSafeTransition(springs.pane);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const open = dock.sheetOpen;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dock.dismissSheet();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const items = focusableWithin(panelRef.current);
    if (items.length === 0) { event.preventDefault(); return; }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <AnimatePresence>
      {open && (
        <div key="sheet" className="shell-sheet-layer" onKeyDown={onKeyDown}>
          <motion.div aria-hidden className="shell-sheet-backdrop" variants={backdrop} initial="hidden" animate="shown" exit="exit"
            onClick={dock.dismissSheet} />
          <motion.div ref={panelRef} role="dialog" aria-modal="true" aria-label="Previews" tabIndex={-1}
            className="shell-sheet" data-testid="preview-sheet"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={spring}>
            <div className="shell-sheet-head">
              <span className="text-[12.5px] font-semibold text-fg">Previews</span>
              <span className="text-2xs text-fg-subtle">Esc closes</span>
              <IconButton aria-label="Close previews" size="sm" icon={<X aria-hidden />} onClick={dock.dismissSheet} className="ml-auto" />
            </div>
            <div className="min-h-0 flex-1">
              <DockPanes />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/** One pane, or both stacked with a resizable divider. */
function DockPanes() {
  const { dock } = useShell();
  const [preferences, update] = useConsolePreferences();
  const { live, list } = dock.visible;
  if (live && list) {
    return (
      <SplitPane direction="vertical" ratio={preferences.sizes.split} onChange={split => update({ sizes: { split } })}
        minFirst={180} minSecond={160} label="Resize live and list previews"
        first={<LivePane />} second={<ListPane />} />
    );
  }
  return live ? <LivePane /> : list ? <ListPane /> : null;
}

function PaneFrame({ children }: { children: ReactNode }) {
  return <div className="shell-pane">{children}</div>;
}

function PaneBody({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="shell-pane-body" data-testid={testId}>{children}</div>;
}

function PaneFallback() {
  const { viewed } = useShell();
  if (viewed.waitingForDatabase) {
    return <EmptyState compact icon={<DatabaseZap />} title="Waiting for the database" description="The preview returns when PostgreSQL is reachable again." />;
  }
  if (viewed.status === 'error') {
    return (
      <EmptyState compact icon={<CalendarX />} title="Could not load this event"
        description={viewed.error?.message} action={<Button size="sm" onClick={viewed.retry}>Try again</Button>} />
    );
  }
  if (viewed.status === 'loading') {
    return <div role="status" className="grid h-full place-items-center text-xs text-fg-subtle"><span className="inline-flex items-center gap-2"><LoaderCircle aria-hidden className="size-4 animate-spin" />Loading event…</span></div>;
  }
  return <EmptyState compact icon={<CalendarX />} title="No active event" description="Previews follow the active event as soon as one starts." />;
}

function LivePane() {
  const shell = useShell();
  const clock = useServerClock();
  const { snapshot } = shell.viewed;
  return (
    <PaneFrame>
      <PaneHeader title="Live preview" icon={<Workflow />} onClose={() => shell.dock.close('live')} />
      <PaneBody testId="live-pane">
        {snapshot
          ? <LivePreview snapshot={snapshot} view={shell.canvasView} matchId={shell.liveMatch}
              onViewChange={shell.setCanvas} getServerNow={clock.now} className="shell-flow" />
          : <PaneFallback />}
      </PaneBody>
    </PaneFrame>
  );
}

function ListPane() {
  const shell = useShell();
  const [preferences, update] = useConsolePreferences();
  const { snapshot } = shell.viewed;
  return (
    <PaneFrame>
      <PaneHeader title="List preview" icon={<Table2 />} onClose={() => shell.dock.close('list')} />
      <PaneBody testId="list-pane">
        {snapshot
          ? <ListPreview snapshot={snapshot} tab={preferences.listTab} onTabChange={listTab => update({ listTab })}
              onOpenMatch={shell.openMatch} className="h-full" />
          : <PaneFallback />}
      </PaneBody>
    </PaneFrame>
  );
}
