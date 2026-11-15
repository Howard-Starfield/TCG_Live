// "Bot setup guide": the short, accurate checklist for creating and inviting the Discord bot. Shown
// collapsed in the setup wizard and the Admin tools Settings tab; README.md carries the same steps.
import { cx, Disclosure } from '../../ui';
import { GrantPermissionsLink } from './PermissionIssues';

export const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';
/** View Channel + Connect: all a helper voice bot needs in the match rooms. */
export const HELPER_VOICE_PERMISSIONS = '1049600';

export function BotSetupGuide({ inviteUrl, defaultOpen = false, className }: { inviteUrl?: string | null; defaultOpen?: boolean; className?: string }) {
  return <Disclosure summary="Bot setup guide" meta="6 steps" defaultOpen={defaultOpen} className={cx('border border-line', className)}>
    <ol aria-label="Bot setup steps" className="flex list-decimal flex-col gap-2 py-2 pl-8 pr-3 text-xs text-fg-muted">
      <li>Create an application at{' '}
        <a href={DEVELOPER_PORTAL_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
          discord.com/developers/applications</a> (New Application).</li>
      <li>Open <b className="text-fg">Bot</b> → <b className="text-fg">Reset Token</b>, copy it and paste it into the local{' '}
        <code>.env</code> file as <code>DISCORD_BOT_TOKEN=</code>. Never share it, paste it in chat or commit it; if it leaks, reset it again.</li>
      <li>On the same page, <b className="text-fg">Privileged Gateway Intents</b>: switch on <b className="text-fg">Server Members Intent</b>{' '}
        only if you use the join/leave log, welcome messages or auto-role, and <b className="text-fg">Message Content Intent</b> only for the
        message log and full ticket transcripts. Presence Intent is not needed.</li>
      <li>Invite the bot with the <b className="text-fg">Grant permissions</b> link (scopes <code>bot</code> and{' '}
        <code>applications.commands</code>) instead of ticking permissions by hand, then press Authorize in Discord.
        {inviteUrl && <span className="mt-1.5 block"><GrantPermissionsLink href={inviteUrl} label="Open the invite link" variant="secondary" /></span>}</li>
      <li>After inviting, open <b className="text-fg">Server Settings → Roles</b> and drag the bot&apos;s role above every role it should give
        (button roles, auto-role, bulk role jobs).</li>
      <li>Optional helper voice bots: invite each helper application the same way with its own client ID; they only need View Channel and
        Connect in the match rooms (<code>permissions={HELPER_VOICE_PERMISSIONS}</code>).</li>
    </ol>
  </Disclosure>;
}
