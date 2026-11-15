// Cross-tab navigation inside the Admin tools page: the selected tab (remembered per browser) and the
// member whose profile the Members tab shows, so other tabs (Logs, Cases) can open a profile.
import { createContext, useContext } from 'react';
import { browserLocalStorage } from '../../data';

export const ADMIN_TOOLS_TAB_KEY = 'tcg-admin.admin-tools.tab.v1';

export interface AdminToolsNavigation {
  /** Shows `tab` (ignored when the session cannot see it). */
  selectTab(tab: string): void;
  /** The member the Members tab shows; kept while switching tabs. */
  memberId: string | null;
  setMemberId(id: string | null): void;
  /** Switches to the Members tab with this member's profile open; null outside the Admin tools page or without members.read. */
  openMember: ((id: string) => void) | null;
}

const noop: AdminToolsNavigation = { selectTab: () => {}, memberId: null, setMemberId: () => {}, openMember: null };
export const AdminToolsNavigationContext = createContext<AdminToolsNavigation>(noop);

export function useAdminToolsNavigation(): AdminToolsNavigation {
  return useContext(AdminToolsNavigationContext);
}

export function readStoredTab(): string | null { return browserLocalStorage().getItem(ADMIN_TOOLS_TAB_KEY); }
export function storeTab(tab: string): void { browserLocalStorage().setItem(ADMIN_TOOLS_TAB_KEY, tab); }

export const ADMIN_TOOLS_TAB_EVENT = 'tcg-admin-tools:select-tab';

/** Opens `tab` on the Admin tools page, now if it is mounted and on its next mount otherwise (banners, links). */
export function requestAdminToolsTab(tab: string): void {
  storeTab(tab);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(ADMIN_TOOLS_TAB_EVENT, { detail: tab }));
}
