// Channel picker from GET /admin-tools/guild. Reserved tournament channels are listed but disabled when
// `allowReserved` is false (stickies, ticket panels).
import type { GuildChannelDto } from '@tcg-live/core';
import { Select } from '../../../ui';
import { useGuildMeta } from '../api';

export function ChannelSelect({ value, onChange, types = ['text', 'announcement'], allowReserved = true, disabled, placeholder = 'None' }: {
  value: string | null; onChange(next: string | null): void; types?: ReadonlyArray<GuildChannelDto['type']>;
  allowReserved?: boolean; disabled?: boolean; placeholder?: string;
}) {
  const meta = useGuildMeta();
  const channels = (meta.data?.channels ?? []).filter(channel => types.includes(channel.type))
    .sort((a, b) => a.position - b.position);
  return <Select value={value ?? ''} disabled={disabled || meta.isPending} onChange={event => onChange(event.target.value || null)}>
    <option value="">{meta.isPending ? 'Loading channels…' : placeholder}</option>
    {channels.map(channel => <option key={channel.id} value={channel.id} disabled={!allowReserved && channel.reserved}>
      {channel.type === 'category' ? channel.name : `#${channel.name}`}{channel.reserved ? ' (tournament)' : ''}
    </option>)}
    {value && !channels.some(channel => channel.id === value) && <option value={value}>Unknown channel {value}</option>}
  </Select>;
}

export function RoleSelect({ value, onChange, disabled, placeholder = 'Choose a role', allowElevated = false }: {
  value: string | null; onChange(next: string | null): void; disabled?: boolean; placeholder?: string;
  /** Staff roles may be picked (ticket staff, required role); they are never assigned by the bot. */
  allowElevated?: boolean;
}) {
  const meta = useGuildMeta();
  const roles = (meta.data?.roles ?? []).filter(role => role.id !== meta.data?.guildId);
  return <Select value={value ?? ''} disabled={disabled || meta.isPending} onChange={event => onChange(event.target.value || null)}>
    <option value="">{meta.isPending ? 'Loading roles…' : placeholder}</option>
    {roles.map(role => {
      // `elevated` (staff permissions) is sent by newer servers; such roles are never handed out by the bot.
      const elevated = (role as { elevated?: unknown }).elevated === true;
      return <option key={role.id} value={role.id} disabled={role.managed || role.aboveBot || (elevated && !allowElevated)}>
        @{role.name}{role.aboveBot ? ' (above the bot)' : role.managed ? ' (managed)' : elevated ? ' (staff permissions)' : ''}
      </option>;
    })}
  </Select>;
}
