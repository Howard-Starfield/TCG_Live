// The setup wizard's last step: where each feature lives once the dashboard opens.
import { BotSetupGuide } from '../bot-permissions/BotSetupGuide';

export interface FeatureLink { id: string; name: string; where: string; what: string }

export const WHATS_NEXT: readonly FeatureLink[] = [
  { id: 'admin-tools', name: 'Admin tools', where: 'Sidebar → Admin tools',
    what: 'Members and cases, stickies, tickets, button roles, announcements and logs. Its Settings tab checks the bot’s Discord permissions.' },
  { id: 'moderation', name: 'Moderation & evidence', where: 'Sidebar → Moderation & evidence',
    what: 'Keyword and volume flags, match evidence, retention and the operations audit.' },
  { id: 'bots', name: 'Helper bots', where: 'Admin tools → Bots',
    what: 'Add helper bot tokens so several match rooms can be monitored at once. Turn on voice monitoring first.' },
  { id: 'lfg', name: 'Looking for a game (LFG)', where: 'Admin tools → LFG',
    what: 'Pick LFG channels, post the sticky “Looking for a game” button and customise every message.' },
  { id: 'capabilities', name: 'Capabilities', where: 'Sidebar → Capabilities',
    what: 'What this dashboard session may do, and which settings turn each feature on.' },
  { id: 'options', name: 'Dashboard options', where: 'Sidebar → Dashboard options',
    what: '“Allow dashboard actions” and voice monitoring, the switches you set on the previous step.' }
];

export function WhatsNext({ inviteUrl }: { inviteUrl: string | null }) {
  return <div className="space-y-4">
    <p className="text-sm text-fg-muted">The dashboard opens in a new tab; this setup tab can then be closed. Here is where to find everything:</p>
    <ul aria-label="Features" className="grid gap-3 sm:grid-cols-2">
      {WHATS_NEXT.map(item => <li key={item.id} data-feature={item.id} className="rounded-lg border border-line bg-sunken p-3">
        <p className="font-medium">{item.name}</p>
        <p className="mt-0.5 text-xs font-medium text-accent">{item.where}</p>
        <p className="mt-1 text-xs text-fg-muted">{item.what}</p>
      </li>)}
    </ul>
    <BotSetupGuide inviteUrl={inviteUrl} />
    <p className="text-xs text-fg-subtle">Permission problems show as a banner in the dashboard, with a link to Admin tools → Settings.</p>
  </div>;
}
