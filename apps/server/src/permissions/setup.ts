// The setup wizard's Readiness step: the per-channel gaps the onboarding discovery found, as the same
// issues and invite links the Admin tools permission card uses.
import type { PermissionIssueDto, PermissionReportDto, SetupCapabilityDto } from '@tcg-live/core';
import { permissionReport } from './checker.js';
import { permissionBits, permissionLabel, requirement, type FeatureRequirement } from './table.js';

export interface SetupPermissionInput {
  applicationId: string;
  guildId: string | null;
  publicMatchRooms: boolean;
  capabilities: readonly SetupCapabilityDto[];
  checkedAtMs: number;
}

export function setupPermissionReport(input: SetupPermissionInput): PermissionReportDto {
  const signup = requirement('tournament.signup');
  const room = requirement('tournament.matchRoom');
  const publicRoom = requirement('tournament.publicRoom');
  const roomCategory = requirement('tournament.roomCategory');
  const roomChat = requirement('tournament.roomChat');
  const pooled = input.capabilities.some(row => row.slot === 'rooms');
  const used: FeatureRequirement[] = [signup, requirement('tournament.pin'), room, requirement('tournament.roundRooms'),
    ...(input.publicMatchRooms ? [publicRoom] : []), ...(pooled ? [roomCategory, roomChat] : [])];
  const issues: PermissionIssueDto[] = [];
  const seen = new Set<string>();
  for (const row of input.capabilities) {
    if (!row.missing.length || seen.has(row.channelId)) continue;
    seen.add(row.channelId);
    // The rooms row is a category, or the server itself (its ID) when rooms go top level or in a category the bot creates.
    const serverWide = row.slot === 'rooms' && row.channelId === input.guildId;
    const scope = serverWide ? { kind: 'guild' as const } : { kind: 'channel' as const, id: row.channelId, name: row.channelName };
    const reqs = row.slot === 'rooms' ? [roomCategory, roomChat] :
      row.slot === 'signup' || row.channelId === input.capabilities[0]?.channelId ? [signup] : [room, publicRoom];
    for (const req of reqs) {
      const names = req.permissions.map(key => permissionLabel(key, 'channel'));
      const missing = row.missing.filter(name => names.includes(name));
      if (!missing.length) continue;
      if (serverWide) {
        issues.push({ severity: req.severity, kind: 'permission', featureId: req.id, feature: req.group,
          permission: req.permissions.filter(key => missing.includes(permissionLabel(key, 'channel'))).map(key => permissionLabel(key)).join(', '),
          scope, why: req.why, fix: 'Use "Grant missing permissions" and authorize the bot again.' });
        continue;
      }
      const hidden = missing.includes('View Channel') && row.channelName === 'Channel not visible to bot';
      issues.push({ severity: row.slot === 'rooms' ? req.severity : 'blocking', kind: hidden ? 'missing' : 'permission', featureId: req.id, feature: req.group,
        permission: missing.join(', '), scope, why: req.why,
        fix: hidden ? 'Allow View Channel for the bot on this channel, or choose another channel.'
          : `Use "Grant missing permissions"; if #${row.channelName} still denies it, allow it for the bot in the channel's Permissions.` });
    }
  }
  return permissionReport({ issues, enabledBits: permissionBits(used.flatMap(item => item.permissions)) },
    { applicationId: input.applicationId, guildId: input.guildId, checkedAtMs: input.checkedAtMs, botRoleName: null });
}
