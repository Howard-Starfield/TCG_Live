// The top-level Admin tools page: a tab strip over the registry. The selected tab is remembered per browser,
// and AdminToolsNavigationContext lets tabs open each other (e.g. Logs -> a member's profile).
import { useCallback, useMemo, useState } from 'react';
import { useSession } from '../../data';
import { TabPanel, TabStrip } from '../../ui';
import { useAdminToolsAccess } from './api';
import { AdminToolsNavigationContext, readStoredTab, storeTab, type AdminToolsNavigation } from './navigation';
import { adminToolsTabs, visibleAdminToolsTabs, type AdminToolsTab } from './registry';
import './admin-tools.css';

export function AdminToolsPage({ tabs = adminToolsTabs, initialTab }: { tabs?: readonly AdminToolsTab[]; initialTab?: string }) {
  const session = useSession();
  const access = useAdminToolsAccess();
  const visible = useMemo(() => visibleAdminToolsTabs(capability => session.hasCapability(capability), tabs), [session, tabs]);
  const [selected, setSelected] = useState(() => initialTab ?? readStoredTab() ?? visible[0]?.id ?? '');
  const [memberId, setMemberId] = useState<string | null>(null);
  const current = visible.find(tab => tab.id === selected) ?? visible[0];
  const select = useCallback((tab: string) => { setSelected(tab); storeTab(tab); }, []);
  const membersVisible = visible.some(tab => tab.id === 'members');
  const navigation = useMemo<AdminToolsNavigation>(() => ({
    selectTab: tab => { if (visible.some(item => item.id === tab)) select(tab); },
    memberId, setMemberId,
    openMember: membersVisible ? id => { setMemberId(id); select('members'); } : null
  }), [memberId, membersVisible, select, visible]);
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
    <TabStrip label="Admin tools sections" idBase="admin-tools" value={current.id} onChange={select}
      tabs={visible.map(tab => ({ value: tab.id, label: tab.label, icon: <tab.icon /> }))}
      className="admin-tools-tabs w-max max-w-full shrink-0 overflow-x-auto overflow-y-hidden rounded-[9px] bg-line-faint p-0.5" />
    <TabPanel idBase="admin-tools" value={current.id} className="min-h-0 flex-1 overflow-y-auto">
      <AdminToolsNavigationContext.Provider value={navigation}>
        <Current />
      </AdminToolsNavigationContext.Provider>
    </TabPanel>
  </section>;
}
