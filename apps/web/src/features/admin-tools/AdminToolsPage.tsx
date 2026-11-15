// The top-level Admin tools page: a tab strip over the registry. The selected tab is remembered per browser,
// and AdminToolsNavigationContext lets tabs open each other (e.g. Logs -> a member's profile).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../data';
import { TabPanel, TabStrip } from '../../ui';
import { useAdminToolsAccess } from './api';
import { ADMIN_TOOLS_TAB_EVENT, AdminToolsNavigationContext, currentConsoleRoute, parseConsoleHash, readStoredTab, storeTab, writeConsoleRoute,
  type AdminToolsNavigation } from './navigation';
import { adminToolsTabs, visibleAdminToolsTabs, type AdminToolsTab } from './registry';
import { useWheelScrollX } from './useWheelScrollX';

export function AdminToolsPage({ tabs = adminToolsTabs, initialTab }: { tabs?: readonly AdminToolsTab[]; initialTab?: string }) {
  const session = useSession();
  const access = useAdminToolsAccess();
  const visible = useMemo(() => visibleAdminToolsTabs(capability => session.hasCapability(capability), tabs), [session, tabs]);
  // A deep link (#/admin-tools/<tab>/<item>) wins over the remembered tab, so a reload keeps your place.
  const [linked] = useState(() => { const route = currentConsoleRoute(); return route?.page === 'admin-tools' ? route : null; });
  const [selected, setSelected] = useState(() => initialTab ?? linked?.tab ?? readStoredTab() ?? visible[0]?.id ?? '');
  const [item, setItem] = useState<string | null>(() => (!initialTab && linked?.tab ? linked.item : null));
  const [memberId, setMemberIdState] = useState<string | null>(() => (!initialTab && linked?.tab === 'members' ? linked.item : null));
  const current = visible.find(tab => tab.id === selected) ?? visible[0];
  const select = useCallback((tab: string) => { setSelected(tab); storeTab(tab); setItem(null); }, []);
  const setMemberId = useCallback((id: string | null) => { setMemberIdState(id); setItem(id); }, []);
  // The address bar follows the page: tab and open item.
  const currentId = current?.id ?? null;
  useEffect(() => { if (currentId) writeConsoleRoute({ page: 'admin-tools', tab: currentId, item }); }, [currentId, item]);
  // Editing the hash by hand (or Back) moves the page.
  useEffect(() => {
    const onHash = () => {
      const route = parseConsoleHash(window.location.hash);
      if (route?.page !== 'admin-tools' || !route.tab || !visible.some(tab => tab.id === route.tab)) return;
      setSelected(route.tab); storeTab(route.tab); setItem(route.item);
      if (route.tab === 'members') setMemberIdState(route.item);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [visible]);
  const membersVisible = visible.some(tab => tab.id === 'members');
  const navigation = useMemo<AdminToolsNavigation>(() => ({
    selectTab: tab => { if (visible.some(item => item.id === tab)) select(tab); },
    memberId, setMemberId,
    openMember: membersVisible ? id => { select('members'); setMemberId(id); } : null,
    item, setItem
  }), [item, memberId, membersVisible, select, setMemberId, visible]);
  // Requests from outside the page (the permission banner) switch tabs while the page is open.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const tab = (event as CustomEvent<string>).detail;
      // A new tab drops the open item, so the address bar never pairs it with another tab's item.
      if (typeof tab === 'string' && visible.some(item => item.id === tab)) { setSelected(tab); setItem(null); }
    };
    window.addEventListener(ADMIN_TOOLS_TAB_EVENT, onRequest);
    return () => window.removeEventListener(ADMIN_TOOLS_TAB_EVENT, onRequest);
  }, [visible]);
  const tabRow = useRef<HTMLDivElement>(null);
  const ready = !!access && !!current;
  useWheelScrollX(tabRow, ready);
  // Keep the selected tab visible when it is chosen from elsewhere (keyboard, Logs -> Members, restored tab).
  useEffect(() => {
    if (!ready) return;
    const active = tabRow.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [ready, current?.id]);
  if (!access || !current) {
    return <section className="p-6"><h1 className="text-lg font-semibold text-fg">Admin tools</h1>
      <p className="mt-2 text-xs text-fg-muted">This session cannot use the admin tools.</p></section>;
  }
  const Current = current.Component;
  return <section aria-labelledby="admin-tools-title" className="admin-tools-page flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6">
    <header className="flex flex-col gap-1">
      <h1 id="admin-tools-title" className="text-lg font-semibold text-fg">Admin tools</h1>
      <p className="text-xs text-fg-muted">Members, cases, channels, tickets, roles, announcements and logs for this Discord server.</p>
    </header>
    <div ref={tabRow} data-testid="admin-tools-tab-row" className="admin-tools-tabs max-w-full shrink-0 overflow-x-auto overflow-y-hidden pb-1">
      <TabStrip label="Admin tools sections" idBase="admin-tools" value={current.id} onChange={select}
        tabs={visible.map(tab => ({ value: tab.id, label: tab.label, icon: <tab.icon /> }))}
        className="w-max rounded-[9px] bg-line-faint p-0.5" />
    </div>
    <TabPanel idBase="admin-tools" value={current.id} className="min-h-0 flex-1 overflow-y-auto">
      <AdminToolsNavigationContext.Provider value={navigation}>
        <Current />
      </AdminToolsNavigationContext.Provider>
    </TabPanel>
  </section>;
}
