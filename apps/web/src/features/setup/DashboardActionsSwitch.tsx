// Reusable local-settings switches (setup wizard, Admin tools settings, capabilities page). Render nothing
// unless the runtime mounts /settings/local (guided start); direct commands use the .env flags instead.
import { Dialog, Field, Switch } from '../../ui';
import { useLocalSettings, useLocalSettingsAvailable } from './localSettings';

export const DASHBOARD_ACTIONS_HELP = 'Lets this dashboard publish, run signups, judge and correct matches, open tournaments and change '
  + 'server tools: the same as TCG_ADMIN_COMMANDS=1. Off keeps the dashboard read-only.';
export const VOICE_MONITORING_HELP = 'Helper voice bots join match rooms self-muted to flag loud moments and record evidence. '
  + 'Applies when the bot starts.';

/** "Allow dashboard actions". Applies to every open dashboard tab at once; no restart or new sign-in. */
export function DashboardActionsSwitch({ className }: { className?: string }) {
  const available = useLocalSettingsAvailable();
  const local = useLocalSettings();
  if (!available) return null;
  const value = local.settings?.dashboardActions;
  return <div className={className} data-local-setting="dashboardActions">
    <Field label="Allow dashboard actions" inline
      description={value?.forcedByEnv ? 'On because TCG_ADMIN_COMMANDS=1 is set in .env. Remove that line to use this switch.'
        : DASHBOARD_ACTIONS_HELP}>
      <Switch checked={value?.enabled ?? false} disabled={!value || value.forcedByEnv || local.saving}
        onCheckedChange={next => { void local.save({ dashboardActions: next }); }} />
    </Field>
    {local.error && <p role="alert" className="mt-1 text-xs text-danger">{local.error}</p>}
  </div>;
}

/** Voice monitoring. Saved now; the running bot picks it up after a restart (the notice says so). */
export function VoiceMonitoringSwitch({ className, setup = false }: { className?: string; setup?: boolean }) {
  const available = useLocalSettingsAvailable();
  const local = useLocalSettings();
  if (!available) return null;
  const value = local.settings?.voiceMonitoring;
  return <div className={className} data-local-setting="voiceMonitoring">
    <Field label="Voice monitoring" inline
      description={value?.forcedByEnv ? 'On because TCG_DISCORD_VOICE=1 is set in .env. Remove that line to use this switch.'
        : VOICE_MONITORING_HELP}>
      <Switch checked={value ? value.forcedByEnv || value.saved : false} disabled={!value || value.forcedByEnv || local.saving}
        onCheckedChange={next => { void local.save({ voiceMonitoring: next }); }} />
    </Field>
    {value?.restartRequired && !setup && <p role="status" className="mt-1 text-xs text-warning">
      Saved. Restart TCG Live (close it and run npm start again) to {value.saved ? 'start' : 'stop'} voice monitoring.</p>}
    {local.error && <p role="alert" className="mt-1 text-xs text-danger">{local.error}</p>}
  </div>;
}

/** Both switches, for a settings section. */
export function LocalSettingsPanel({ className, setup = false }: { className?: string; setup?: boolean }) {
  const available = useLocalSettingsAvailable();
  if (!available) return null;
  return <section aria-label="Dashboard options" className={className}>
    <h2 className="text-sm font-semibold">Dashboard options</h2>
    <p className="mt-1 text-xs text-fg-muted">Saved on this computer in data/discord-setup.json. Change them later under Dashboard options in the sidebar.</p>
    <div className="mt-3 space-y-3">
      <DashboardActionsSwitch />
      <VoiceMonitoringSwitch setup={setup} />
    </div>
  </section>;
}

/** "Dashboard options" dialog (sidebar). */
export function LocalSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title="Dashboard options"
    description="Saved on this computer. Dashboard actions apply at once; voice monitoring after a restart.">
    <div className="space-y-3"><DashboardActionsSwitch /><VoiceMonitoringSwitch /></div>
  </Dialog>;
}
