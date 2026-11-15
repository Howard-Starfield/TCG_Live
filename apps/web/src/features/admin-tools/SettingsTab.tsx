// Foundation Settings tab: privileged-intent status with Developer Portal guidance, restart notice, and the
// shared "cases" section (DM members, case log channel) saved through the 409-aware section editor.
import { PRIVILEGED_INTENT_NAMES, PRIVILEGED_INTENT_PORTAL_LABELS, type AdminToolsStatusDto, type PrivilegedIntentName,
  type PrivilegedIntentState } from '@tcg-live/core';
import { CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge, Button, Field, Switch, type Tone } from '../../ui';
import { describeError } from '../evidence/api';
import { useAdminToolsCapability, useAdminToolsSection, useAdminToolsStatus } from './api';
import { ChannelSelect } from './shared/ChannelSelect';
import { SectionFrame } from './shared/SectionFrame';

const NEEDED_BY = { guildMembers: 'join/leave log, welcome messages and auto-role', messageContent: 'the message edit/delete log' } as const;
const FEATURE_STATE = { running: 'running', 'intent-missing': 'missing an intent', failed: 'failed to start', stopped: 'stopped' } as const;

/** One intent's badge: what the running bot has, read against what the saved settings want. */
export function intentBadge(status: AdminToolsStatusDto, name: PrivilegedIntentName): { label: string; tone: Tone } {
  const state: PrivilegedIntentState = status.privilegedIntents[name];
  const wanted = status.wantedIntents[name];
  if (status.runtime === 'offline') return { label: wanted ? 'Requested at next start' : 'Not needed', tone: 'neutral' };
  if (state === 'on') return wanted ? { label: 'On', tone: 'success' } : { label: 'On (no longer needed)', tone: 'neutral' };
  if (state === 'missing') return wanted ? { label: 'Refused by Discord', tone: 'danger' } : { label: 'Refused (no longer needed)', tone: 'neutral' };
  return wanted ? { label: 'Restart to request', tone: 'warning' } : { label: 'Not needed', tone: 'neutral' };
}

export function IntentStatusCard({ status }: { status: AdminToolsStatusDto }) {
  const portal = PRIVILEGED_INTENT_NAMES.filter(name => status.wantedIntents[name] && status.privilegedIntents[name] !== 'on');
  const runtimeLabel = status.runtime === 'demo' ? 'Demo' : status.runtime === 'running' ? 'Bot online' : 'Bot offline';
  return <section aria-label="Bot status" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Privileged intents</h3>
      <Badge tone={status.runtime === 'running' ? 'success' : 'neutral'}>{runtimeLabel}</Badge>
    </header>
    <ul className="flex flex-col gap-2">
      {PRIVILEGED_INTENT_NAMES.map(name => <li key={name} className="flex items-center gap-2 text-xs">
        <span className="flex-1"><b className="font-medium text-fg">{PRIVILEGED_INTENT_PORTAL_LABELS[name]}</b>
          <span className="block text-fg-subtle">Needed by {NEEDED_BY[name]}{status.wantedIntents[name] ? ' (enabled in your settings)' : ''}.</span></span>
        <Badge tone={intentBadge(status, name).tone}>{intentBadge(status, name).label}</Badge>
      </li>)}
    </ul>
    {portal.length > 0 && <p className="flex gap-2 rounded-md bg-line-faint p-2 text-xs text-fg-muted">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>Turn on <b>{portal.map(name => PRIVILEGED_INTENT_PORTAL_LABELS[name]).join(' and ')}</b> in the Discord Developer Portal
        (your application, then Bot, then Privileged Gateway Intents){status.runtime === 'demo' ? '' : ' before restarting the bot'}. Without it
        Discord rejects the login with Disallowed intents; the bot then starts without it and{' '}
        {portal.map(name => NEEDED_BY[name]).join(' and ')} stay idle.</span>
    </p>}
    {status.restartRequired ? <p role="status" className="flex gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <RefreshCw aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span><b>Restart required.</b>{' '}
        {status.restartReason ?? 'The saved settings need a different set of intents. Restart the bot to apply them.'}</span>
    </p> : status.runtime === 'running' ? <p className="flex items-center gap-2 text-xs text-fg-muted">
      <CircleCheck aria-hidden className="size-3.5 text-success" />The running bot matches your settings.</p>
      : status.runtime === 'offline' && <p className="text-xs text-fg-muted">The bot is not running. The intents above are requested when it starts.</p>}
    {status.features.some(feature => feature.state !== 'running') && <ul className="flex flex-wrap gap-1.5" aria-label="Feature states">
      {status.features.filter(feature => feature.state !== 'running').map(feature =>
        <li key={feature.name}><Badge tone={feature.state === 'failed' || feature.state === 'intent-missing' ? 'danger' : 'neutral'}>
          {feature.name}: {FEATURE_STATE[feature.state]}{feature.missingIntents.length
            ? ` (${feature.missingIntents.map(name => PRIVILEGED_INTENT_PORTAL_LABELS[name]).join(', ')})` : ''}</Badge></li>)}
    </ul>}
  </section>;
}

export function SettingsTab() {
  const status = useAdminToolsStatus();
  const cases = useAdminToolsSection('cases');
  const canEdit = useAdminToolsCapability('server.manage');
  return <div className="flex flex-col gap-4">
    {status.data ? <IntentStatusCard status={status.data} />
      : status.error ? <p role="alert" className="text-xs text-danger">{describeError(status.error, 'Status could not be loaded.')}{' '}
        <Button size="sm" variant="ghost" onClick={() => { void status.refetch(); }}>Try again</Button></p>
      : <p role="status" className="text-xs text-fg-muted">Loading status…</p>}
    <SectionFrame editor={cases} title="Cases" canEdit={canEdit}
      description="Applies to warn, timeout, kick and ban from the dashboard and from Discord.">
      {cases.value && <>
        <Field label="DM the member" inline description="Send the reason by direct message (best effort; closed DMs fail quietly).">
          <Switch checked={cases.value.dmMembers} disabled={!canEdit} onCheckedChange={dmMembers => cases.setValue({ ...cases.value!, dmMembers })} />
        </Field>
        <Field label="Case log channel" description="Each new case is posted here. Leave empty to keep cases in the dashboard only.">
          <ChannelSelect value={cases.value.logChannelId} disabled={!canEdit}
            onChange={logChannelId => cases.setValue({ ...cases.value!, logChannelId })} />
        </Field>
      </>}
    </SectionFrame>
  </div>;
}
