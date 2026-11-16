// The only list feature agents edit to add admin-tools HTTP routes: import your module from your own file
// and append it here (one line each). routes.ts mounts them after the foundation routes, in this order.
import type { AdminToolsRouteModule } from './module.js';
import { membersModule } from './members/routes.js';
import { channelsRouteModule } from './channels/routes.js';
import { ticketsRouteModule } from './tickets/routes.js';
import { loggingRouteModule } from './logging/routes.js';
import { rolesRouteModule } from './roles/routes.js';
import { announcementsRouteModule } from './announcements/routes.js';
import { lfgRouteModule } from './lfg/routes.js';
import { tournamentRolesRouteModule } from './tournament-roles/routes.js';

export const adminToolsRouteModules: readonly AdminToolsRouteModule[] = [
  // (A) members, bans, mod actions, cases, notes, mod audit
  membersModule,
  // (B) stickies, channel controls, tickets
  channelsRouteModule(), ticketsRouteModule(),
  // (C) button roles, bulk roles, announcements
  rolesRouteModule(), announcementsRouteModule(),
  // (D) join/leave log, welcome, auto-role, message log
  loggingRouteModule(),
  // LFG (looking for a game)
  lfgRouteModule(),
  // TCG Organizer and TCG Judge roles
  tournamentRolesRouteModule(),
];
