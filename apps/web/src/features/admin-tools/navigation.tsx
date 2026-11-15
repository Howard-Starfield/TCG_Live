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
  /** The item segment of the deep link (#/admin-tools/<tab>/<item>): a case number, member ID or ticket ID. */
  item?: string | null;
  /** Records the open item in the address bar (null when it closes), so a reload keeps your place. */
  setItem?(item: string | null): void;
}

const noop: AdminToolsNavigation = { selectTab: () => {}, memberId: null, setMemberId: () => {}, openMember: null, item: null, setItem: () => {} };
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

// ---- Deep links ----
// Console pages live in the hash path: #/admin-tools, #/admin-tools/<tab>, #/admin-tools/<tab>/<item> and
// #/capabilities. The path form never collides with the console link's #login=<token> parameter (that one is
// parsed as URL parameters and stripped on load), and dev galleries use #/__name, which is ignored here.

export type ConsoleRoute =
  | { page: 'admin-tools'; tab: string | null; item: string | null }
  | { page: 'capabilities' };

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Parses a location hash; null for anything that is not a console route (login fragment, galleries, empty). */
export function parseConsoleHash(hash: string): ConsoleRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('/') || raw.startsWith('/__')) return null;
  const parts = raw.slice(1).split(/[?&]/)[0]!.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
  if (parts[0] === 'capabilities' && parts.length === 1) return { page: 'capabilities' };
  if (parts[0] !== 'admin-tools' || parts.length > 3 || parts.slice(1).some(part => !SEGMENT.test(part))) return null;
  return { page: 'admin-tools', tab: parts[1] ?? null, item: parts[2] ?? null };
}

export function formatConsoleHash(route: ConsoleRoute): string {
  if (route.page === 'capabilities') return '#/capabilities';
  return `#/admin-tools${route.tab ? `/${encodeURIComponent(route.tab)}${route.item ? `/${encodeURIComponent(route.item)}` : ''}` : ''}`;
}

/** The console route in the address bar now. */
export function currentConsoleRoute(): ConsoleRoute | null {
  return typeof window === 'undefined' ? null : parseConsoleHash(window.location.hash);
}

/**
 * Writes `route` (or, with null, clears a console route) into the address bar without a navigation or
 * hashchange event. Any other fragment (a pending #login=) is left alone.
 */
export function writeConsoleRoute(route: ConsoleRoute | null): void {
  if (typeof window === 'undefined') return;
  const { location, history } = window;
  const current = parseConsoleHash(location.hash);
  if (route === null && current === null) return;
  if (route === null) { history.replaceState(history.state, '', `${location.pathname}${location.search}`); return; }
  if (current === null && location.hash && location.hash !== '#') return;
  const next = formatConsoleHash(route);
  if (location.hash !== next) history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`);
}
