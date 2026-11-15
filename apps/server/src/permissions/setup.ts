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
  const used: FeatureRequirement[] = [signup, requirement('tournament.pin'), room, requirement('tournament.roundRooms'),
    ...(input.publicMatchRooms ? [publicRoom] : [])];
  const issues: PermissionIssueDto[] = [];
  const seen = new Set<string>();
  for (const row of input.capabilities) {
    if (!row.missing.length || seen.has(row.channelId)) continue;
    seen.add(row.channelId);
    const scope = { kind: 'channel' as const, id: row.channelId, name: row.channelName };
    const reqs = row.slot === 'signup' || row.channelId === input.capabilities[0]?.channelId ? [signup] : [room, publicRoom];
    for (const req of reqs) {
      const names = req.permissions.map(key => permissionLabel(key, 'channel'));
      const missing = row.missing.filter(name => names.includes(name));
      if (!missing.length) continue;
      const hidden = missing.includes('View Channel') && row.channelName === 'Channel not visible to bot';
      issues.push({ severity: 'blocking', kind: hidden ? 'missing' : 'permission', featureId: req.id, feature: req.group,
        permission: missing.join(', '), scope, why: req.why,
        fix: hidden ? 'Allow View Channel for the bot on this channel, or choose another channel.'
          : `Use "Grant missing permissions"; if #${row.channelName} still denies it, allow it for the bot in the channel's Permissions.` });
    }
  }
  return permissionReport({ issues, enabledBits: permissionBits(used.flatMap(item => item.permissions)) },
    { applicationId: input.applicationId, guildId: input.guildId, checkedAtMs: input.checkedAtMs, botRoleName: null });
}
