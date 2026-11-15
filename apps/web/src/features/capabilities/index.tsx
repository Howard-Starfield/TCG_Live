// Capabilities & shortcuts feature: the page, the "?" shortcuts overlay, the data and the sidebar item.
import { BookOpen } from 'lucide-react';
import type { SidebarItem } from '../../ui';

export { CapabilitiesPage, CapabilitiesView, navigateTo, type CapabilityNavigator } from './CapabilitiesPage';
export { ShortcutsOverlay, ShortcutList } from './ShortcutsOverlay';
export { CAPABILITIES, CAPABILITY_AREAS, SHORTCUTS, filterCapabilities, filterShortcuts, type CapabilityEntry } from './capabilities';
export { capabilityStatus, useCapabilityContext, type CapabilityContext, type CapabilityStatus } from './status';

/** Sidebar "Dashboard" list item: id 'capabilities' → shell.showCapabilities(). */
export function capabilitiesNavItem(active: boolean): SidebarItem {
  return { id: 'capabilities', label: 'Capabilities & shortcuts', icon: <BookOpen />, active };
}
