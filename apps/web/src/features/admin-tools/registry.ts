// The Admin tools page's tab list: one entry per feature tab, each component from its own folder.
import type { Capability } from '@tcg-live/core';
import { Ban, Hash, Megaphone, Pin, ScrollText, Settings, Tags, Ticket, Users, Wrench, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { SettingsTab } from './SettingsTab';
import { StickiesTab } from './stickies/StickiesTab';
import { ChannelsTab } from './channels/ChannelsTab';
import { TicketsTab } from './tickets/TicketsTab';
import { BansTab } from './members/BansTab';
import { CasesTab } from './members/CasesTab';
import { MembersTab } from './members/MembersTab';
import { LogsTab } from './logs/LogsTab';
import { RolesTab } from './roles/RolesTab';
import { AnnouncementsTab } from './announcements/AnnouncementsTab';
import { LfgTab } from './lfg/LfgTab';
import { Gamepad2 } from 'lucide-react';
import { AudioLines } from 'lucide-react';
import { BotsTab } from './bots/BotsTab';

export interface AdminToolsTab {
  /** Stable, URL-safe ID (also the tab panel ID). */
  id: string;
  label: string;
  icon: LucideIcon;
  /** Hidden when the session lacks it. Read-only tabs use members.read and gate their buttons themselves. */
  capability: Capability;
  Component: ComponentType;
}

export const adminToolsTabs: readonly AdminToolsTab[] = [
  // (A) members, bans, cases
  { id: 'members', label: 'Members', icon: Users, capability: 'members.read',
    Component: MembersTab },
  { id: 'bans', label: 'Bans', icon: Ban, capability: 'members.read',
    Component: BansTab },
  { id: 'cases', label: 'Cases', icon: ScrollText, capability: 'members.read',
    Component: CasesTab },
  // (B) stickies, channels, tickets
  { id: 'stickies', label: 'Stickies', icon: Pin, capability: 'server.manage',
    Component: StickiesTab },
  { id: 'channels', label: 'Channels', icon: Hash, capability: 'members.moderate',
    Component: ChannelsTab },
  { id: 'tickets', label: 'Tickets', icon: Ticket, capability: 'members.read',
    Component: TicketsTab },
  // (C) roles, announcements
  { id: 'roles', label: 'Roles', icon: Tags, capability: 'server.manage',
    Component: RolesTab },
  { id: 'announcements', label: 'Announcements', icon: Megaphone, capability: 'server.manage',
    Component: AnnouncementsTab },
  // LFG (looking for a game)
  { id: 'lfg', label: 'LFG', icon: Gamepad2, capability: 'members.read', Component: LfgTab },
  // Voice bots (helper bots, room policies)
  { id: 'bots', label: 'Bots', icon: AudioLines, capability: 'moderation.manage', Component: BotsTab },
  // (D) logs
  { id: 'logs', label: 'Logs', icon: Wrench, capability: 'members.read',
    Component: LogsTab },
  // Foundation
  { id: 'settings', label: 'Settings', icon: Settings, capability: 'members.read', Component: SettingsTab }
];

export function visibleAdminToolsTabs(can: (capability: Capability) => boolean, tabs: readonly AdminToolsTab[] = adminToolsTabs): AdminToolsTab[] {
  return tabs.filter(tab => can(tab.capability));
}
