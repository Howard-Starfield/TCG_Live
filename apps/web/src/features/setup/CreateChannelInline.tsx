// "New channel" control under a setup channel picker: creates the channel in Discord and hands it back so the
// wizard can select it at once. The bot needs Manage Channels in the server.
import type { SetupChannelDto } from '@tcg-live/core';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { useAdminData } from '../../data';
import { Button, Input } from '../../ui';

export function CreateChannelInline({ guildId, type, defaultName, hint, disabled, onCreated }: {
  guildId: string; type: 'text' | 'voice'; defaultName: string; hint?: string; disabled?: boolean;
  onCreated(channel: SetupChannelDto): void;
}) {
  const { api } = useAdminData();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = type === 'text' ? 'text channel' : 'voice room';

  if (!open) return <Button size="sm" variant="ghost" icon={<Plus aria-hidden />} disabled={disabled || !guildId}
    onClick={() => { setName(defaultName); setError(null); setOpen(true); }}>New {kind}</Button>;

  const create = async () => {
    setBusy(true); setError(null);
    try { onCreated(await api.createSetupChannel({ guildId, name: name.trim(), type })); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Discord did not create the channel.'); }
    finally { setBusy(false); }
  };
  return <div role="group" aria-label={`Create a ${kind}`} className="space-y-1.5 rounded-md border border-line bg-sunken p-2">
    <label htmlFor={inputId} className="text-xs font-medium text-fg">New {kind} name</label>
    <div className="flex flex-wrap items-center gap-2">
      <Input id={inputId} value={name} maxLength={100} className="min-w-0 flex-1" autoFocus
        onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && name.trim()) void create(); if (event.key === 'Escape') setOpen(false); }} />
      <Button size="sm" variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>Create</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
    </div>
    {hint && <p className="text-[11px] text-fg-subtle">{hint}</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
