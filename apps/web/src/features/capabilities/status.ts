// Live status for the capabilities page: what this session and runtime can do right now. Only cheap
// sources: the session, the admin-tools status (intents), the permission report and the moderation settings.
import { useQuery } from '@tanstack/react-query';
import type { ModerationSettingsDto, PermissionIssueDto, PrivilegedIntentName, PrivilegedIntentState } from '@tcg-live/core';
import { useAdminData, useSession } from '../../data';
import { useAdminToolsStatus } from '../admin-tools/api';
import { usePermissionReport } from '../bot-permissions/api';
import { getModerationSettings, useModerationAccess } from '../moderation/api';
import { retryTransient } from '../evidence/api';
import type { CapabilityCheck, CapabilityEntry } from './capabilities';

export type CapabilityState = 'available' | 'needs-setup' | 'off' | 'unknown';
export interface CapabilityStatus { state: CapabilityState; reason: string | null }

export interface CapabilityContext {
  dashboardActions: boolean;
  mounted: { tournaments: boolean; evidence: boolean; moderation: boolean; adminTools: boolean; demo: boolean };
  /** Null when the moderation settings are not readable here. */
  voice: { monitor: boolean; recording: boolean } | null;
  /** Null when the admin-tools status is not readable here. */
  intents: Record<PrivilegedIntentName, PrivilegedIntentState> | null;
  /** Null when no permission report is available. */
  issues: readonly PermissionIssueDto[] | null;
}

const OFF = (reason: string): CapabilityStatus => ({ state: 'off', reason });
const SETUP = (reason: string): CapabilityStatus => ({ state: 'needs-setup', reason });

function check(item: CapabilityCheck, ctx: CapabilityContext): CapabilityStatus | null {
  switch (item) {
    case 'dashboard-actions': return ctx.dashboardActions ? null : OFF('Dashboard actions are turned off for this session.');
    case 'tournaments': return ctx.mounted.tournaments ? null : OFF('The tournament directory is not available in this runtime.');
    case 'evidence': return ctx.mounted.evidence ? null : OFF('Evidence is not available in this runtime.');
    case 'moderation': return ctx.mounted.moderation ? null : OFF('Moderation is not available to this session.');
    case 'admin-tools': return ctx.mounted.adminTools ? null : OFF('Admin tools are not available to this session.');
    case 'demo': return ctx.mounted.demo ? null : OFF('The tournament demo is not available here.');
    case 'voice-monitor': return ctx.voice === null ? null : ctx.voice.monitor ? null : OFF('Voice loudness is turned off in Moderation & evidence.');
    case 'recording': return ctx.voice === null ? null : ctx.voice.recording ? null : OFF('Recording is set to Off in Moderation & evidence.');
    case 'intent:guildMembers':
    case 'intent:messageContent': {
      const name = item.slice('intent:'.length) as PrivilegedIntentName;
      const state = ctx.intents?.[name];
      if (!state || state === 'on') return null;
      const label = name === 'guildMembers' ? 'Server Members' : 'Message Content';
      return SETUP(`Turn on the ${label} intent in the Discord Developer Portal.`);
    }
    default: {
      const prefix = item.slice('perm:'.length);
      const issue = ctx.issues?.find(entry => entry.featureId.startsWith(prefix));
      return issue ? SETUP(`${issue.permission}: ${issue.fix}`) : null;
    }
  }
}

/** The first failing check decides; with no checks (or none failing) the entry is available. */
export function capabilityStatus(entry: CapabilityEntry, ctx: CapabilityContext): CapabilityStatus {
  // Off (the feature is unavailable) outranks needs-setup (it works once fixed).
  const results = (entry.checks ?? []).map(item => check(item, ctx)).filter((value): value is CapabilityStatus => value !== null);
  return results.find(result => result.state === 'off') ?? results[0] ?? { state: 'available', reason: null };
}

/** Builds the live context from the session and cheap queries. */
export function useCapabilityContext(): CapabilityContext {
  const session = useSession();
  const { api } = useAdminData();
  const dto = session.session;
  const moderation = useModerationAccess();
  const adminToolsStatus = useAdminToolsStatus();
  const permissions = usePermissionReport();
  const settings = useQuery({ queryKey: ['admin', 'moderation', 'settings', 'capabilities'], enabled: moderation, staleTime: 30_000,
    retry: retryTransient, queryFn: ({ signal }) => getModerationSettings(api, signal) });
  const data: ModerationSettingsDto | undefined = settings.data;
  return {
    dashboardActions: dto?.commandsEnabled === true,
    mounted: { tournaments: dto?.tournaments === true, evidence: dto?.evidence === true, moderation,
      adminTools: dto?.adminTools === true, demo: dto?.demoAvailable === true || dto?.mode === 'demo' },
    voice: data ? { monitor: data.voice.enabled, recording: data.recording.mode !== 'off' } : null,
    intents: adminToolsStatus.data?.privilegedIntents ?? null,
    issues: permissions.data && !permissions.data.unavailable ? permissions.data.issues : null
  };
}
