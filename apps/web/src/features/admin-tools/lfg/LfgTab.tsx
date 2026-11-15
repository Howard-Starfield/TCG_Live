// LFG tab: settings (channels, games, formats, limits, ping role, voice rooms, every member-facing text) with
// live Discord previews and limit checks, the panel status per channel, the post list with filters and
// close/delete, and stats per game.
import { DEFAULT_LFG_SETTINGS, LFG_LIMITS as L, LFG_PLACEHOLDERS, renderLfgTemplate, type EmbedDto, type LfgChannelDto, type LfgPanelDto,
  type LfgPostDto, type LfgPostStatus, type LfgSettingsBodyDto, type LfgSettingsDto, type LfgTemplateValues } from '@tcg-live/core';
import { useQueryClient } from '@tanstack/react-query';
import { Gamepad2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, Input, SegmentedControl, Select, Switch, Textarea, type Tone } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useAdminToolsCapability, useGuildMeta } from '../api';
import { DiscordPreview } from '../announcements/DiscordPreview';
import { hexColor, parseHexColor } from '../announcements/embed';
import { ChannelSelect, RoleSelect } from '../shared/ChannelSelect';
import { lfgBodyOf, lfgKeys, lfgSettingsProblems, saveLfgSettings, useLfgPanels, useLfgPostMutations, useLfgPosts, useLfgSettings, useLfgStats,
  type LfgPostFilter } from './api';

const STATUS: Record<LfgPostStatus, { label: string; tone: Tone }> = {
  posting: { label: 'Posting', tone: 'neutral' }, open: { label: 'Open', tone: 'success' }, closed: { label: 'Closed', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warning' }, deleted: { label: 'Deleted', tone: 'danger' }
};
const time = (ms: number) => new Date(ms).toLocaleString();

/** Preview values: readable names instead of raw mentions (Discord shows names too). */
export function previewValues(roleName: string | null): LfgTemplateValues {
  return { author: '@Ash', game: 'Pokémon TCG', format: 'Standard', note: 'Chill games, new players welcome.', voice: '🔊 Lounge', count: '3',
    players: '@Ash, @Misty, @Brock', expires: 'in 2 hours', ...(roleName ? { role: `@${roleName}` } : { role: '@LFG' }) };
}

function ColorInput({ value, onChange, disabled, label }: { value: number | null; onChange(next: number | null): void; disabled?: boolean; label: string }) {
  return <div className="flex items-center gap-2">
    <input type="color" aria-label={`${label} picker`} disabled={disabled} value={hexColor(value) || '#1e1f22'} className="h-8 w-10 rounded"
      onChange={event => onChange(parseHexColor(event.target.value))} />
    <Input aria-label={label} value={hexColor(value)} placeholder="#rrggbb" disabled={disabled}
      onChange={event => onChange(event.target.value.trim() ? parseHexColor(event.target.value) ?? value : null)} />
  </div>;
}

function PanelEditor({ value, onChange, disabled, label }: { value: LfgPanelDto; onChange(next: LfgPanelDto): void; disabled: boolean; label: string }) {
  const set = (patch: Partial<LfgPanelDto>) => onChange({ ...value, ...patch });
  return <div className="grid gap-3 xl:grid-cols-2">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={`${label} title`}><Input value={value.title} maxLength={L.panelTitleLength} disabled={disabled} onChange={event => set({ title: event.target.value })} /></Field>
      <Field label={`${label} button label`}><Input value={value.buttonLabel} maxLength={L.buttonLabelLength} disabled={disabled}
        onChange={event => set({ buttonLabel: event.target.value })} /></Field>
      <Field label={`${label} text`} className="sm:col-span-2" description={`${[...value.text].length}/${L.panelTextLength}`}>
        <Textarea rows={3} value={value.text} disabled={disabled} onChange={event => set({ text: event.target.value })} /></Field>
      <Field label={`${label} button emoji`}><Input value={value.emoji ?? ''} placeholder="🎮" disabled={disabled}
        onChange={event => set({ emoji: event.target.value.trim() || null })} /></Field>
      <Field label={`${label} colour`}><ColorInput label={`${label} colour`} value={value.color} disabled={disabled} onChange={color => set({ color })} /></Field>
    </div>
    <DiscordPreview label={`${label} preview`} content={null}
      embed={{ title: value.title, description: value.text, color: value.color, url: null, imageUrl: null, thumbnailUrl: null, footer: null, fields: [] }}
      buttons={[{ label: value.buttonLabel, emoji: value.emoji, style: 'success' }]} />
  </div>;
}

function ListEditor({ label, items, onChange, disabled, max, placeholder }: { label: string; items: string[]; onChange(next: string[]): void;
  disabled: boolean; max: number; placeholder: string }) {
  const [draft, setDraft] = useState('');
  return <Field label={label} description={`Up to ${max}. Leave empty to let members type their own.`}>
    <div className="flex flex-col gap-2">
      <ul aria-label={label} className="flex flex-wrap gap-1.5">
        {items.map(item => <li key={item}><Badge tone="accent">{item}
          {!disabled && <IconButton aria-label={`Remove ${item}`} size="sm" variant="ghost" icon={<X />} onClick={() => onChange(items.filter(entry => entry !== item))} />}
        </Badge></li>)}
      </ul>
      {!disabled && items.length < max && <div className="flex gap-2">
        <Input aria-label={`New ${label.toLowerCase()}`} value={draft} placeholder={placeholder} maxLength={L.formatLength} onChange={event => setDraft(event.target.value)} />
        <Button size="sm" disabled={!draft.trim()} onClick={() => { if (!items.includes(draft.trim())) onChange([...items, draft.trim()]); setDraft(''); }}>Add</Button>
      </div>}
    </div>
  </Field>;
}

function VoiceList({ value, onChange, disabled, label }: { value: string[]; onChange(next: string[]): void; disabled: boolean; label: string }) {
  const meta = useGuildMeta();
  const [add, setAdd] = useState<string | null>(null);
  const name = (id: string) => meta.data?.channels.find(channel => channel.id === id)?.name ?? id;
  return <div className="flex flex-col gap-2">
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {value.map(id => <li key={id}><Badge>🔊 {name(id)}{!disabled && <IconButton aria-label={`Remove ${name(id)}`} size="sm" variant="ghost" icon={<X />}
        onClick={() => onChange(value.filter(item => item !== id))} />}</Badge></li>)}
      {!value.length && <li className="text-xs text-fg-subtle">No voice rooms: the form has no voice field.</li>}
    </ul>
    {!disabled && value.length < L.voiceChannels && <div className="flex gap-2">
      <ChannelSelect value={add} types={['voice', 'stage']} allowReserved={false} placeholder="Add a voice room" onChange={setAdd} />
      <Button size="sm" disabled={!add} onClick={() => { if (add && !value.includes(add)) onChange([...value, add]); setAdd(null); }}>Add</Button>
    </div>}
  </div>;
}

function ChannelRow({ value, index, settings, onChange, onRemove, disabled }: { value: LfgChannelDto; index: number; settings: LfgSettingsBodyDto;
  onChange(next: LfgChannelDto): void; onRemove(): void; disabled: boolean }) {
  const set = (patch: Partial<LfgChannelDto>) => onChange({ ...value, ...patch });
  return <li aria-label={`LFG channel ${index + 1}`} className="flex flex-col gap-3 rounded-md border border-line p-3">
    <div className="flex items-end gap-2">
      <Field label="Channel" className="flex-1">
        <ChannelSelect value={value.channelId || null} allowReserved={false} disabled={disabled} placeholder="Choose a channel"
          onChange={channelId => set({ channelId: channelId ?? '' })} />
      </Field>
      {!disabled && <IconButton aria-label={`Remove LFG channel ${index + 1}`} icon={<Trash2 />} variant="ghost" onClick={onRemove} />}
    </div>
    {settings.games.length > 0 && <Field label="Games here" description="None ticked: every game.">
      <div className="flex flex-wrap gap-3">
        {settings.games.map(game => <label key={game.name} className="flex items-center gap-1.5 text-xs text-fg">
          <input type="checkbox" disabled={disabled} checked={value.games.includes(game.name)}
            onChange={event => set({ games: event.target.checked ? [...value.games, game.name] : value.games.filter(item => item !== game.name) })} />
          {game.emoji} {game.name}
        </label>)}
      </div>
    </Field>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Ping role here" description="Empty: the global ping role.">
        <RoleSelect value={value.pingRoleId} disabled={disabled} placeholder="Global ping role" onChange={pingRoleId => set({ pingRoleId })} />
      </Field>
      <Field label="Own voice rooms" inline>
        <Switch checked={value.voiceChannelIds !== null} disabled={disabled} onCheckedChange={on => set({ voiceChannelIds: on ? [] : null })} />
      </Field>
    </div>
    {value.voiceChannelIds !== null && <VoiceList label={`Voice rooms of channel ${index + 1}`} value={value.voiceChannelIds} disabled={disabled}
      onChange={voiceChannelIds => set({ voiceChannelIds })} />}
    <Field label="Own panel" inline>
      <Switch checked={value.panel !== null} disabled={disabled} onCheckedChange={on => set({ panel: on ? structuredClone(settings.panel) : null })} />
    </Field>
    {value.panel && <PanelEditor label={`Channel ${index + 1} panel`} value={value.panel} disabled={disabled} onChange={panel => set({ panel })} />}
  </li>;
}

const TEMPLATES: Array<[keyof LfgSettingsBodyDto['messages'], string, boolean]> = [
  ['cardTitle', 'Card title', false], ['cardBody', 'Card text', true], ['closedText', 'Closed text', true], ['expiredText', 'Expired text', true],
  ['postedText', 'Posted reply (private)', true], ['joinedText', 'Joined reply (private)', true], ['leftText', 'Left reply (private)', true],
  ['pingText', 'Ping text', true]
];

export function LfgSettingsEditor() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const query = useLfgSettings();
  const meta = useGuildMeta();
  const canEdit = useAdminToolsCapability('server.manage');
  const [draft, setDraft] = useState<LfgSettingsBodyDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const saved = query.data;
  if (query.error) return <p role="alert" className="text-xs text-danger">{describeError(query.error, 'LFG settings could not be loaded.')}</p>;
  if (!saved) return <p role="status" className="text-xs text-fg-muted">Loading LFG settings…</p>;
  const value = draft ?? lfgBodyOf(saved);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(lfgBodyOf(saved));
  const set = (patch: Partial<LfgSettingsBodyDto>) => setDraft({ ...value, ...patch });
  const setMessages = (patch: Partial<LfgSettingsBodyDto['messages']>) => set({ messages: { ...value.messages, ...patch } });
  const problems = lfgSettingsProblems(value);
  const disabled = !canEdit;
  const roleName = (id: string | null) => id ? meta.data?.roles.find(role => role.id === id)?.name ?? null : null;
  const values = previewValues(roleName(value.pingRoleId));
  const cardEmbed = (body: string, open: boolean): EmbedDto => ({ title: renderLfgTemplate(value.messages.cardTitle, values),
    description: renderLfgTemplate(body, values), color: open ? value.messages.cardColor : 0x4e5058, url: null, imageUrl: null, thumbnailUrl: null,
    footer: open ? null : 'Closed', fields: [] });
  const cardButtons = [{ label: value.messages.joinLabel, emoji: null, style: 'success' as const },
    { label: value.messages.leaveLabel, emoji: null, style: 'secondary' as const }, { label: value.messages.closeLabel, emoji: null, style: 'danger' as const }];

  const save = async () => {
    if (saving || !draft) return;
    setSaving(true); setError(null);
    try {
      const result = await saveLfgSettings(api, saved.version, draft);
      queryClient.setQueryData<LfgSettingsDto>(lfgKeys.settings(), result.ok ? result.settings : result.conflict);
      if (result.ok) { setDraft(null); setConflict(false); void queryClient.invalidateQueries({ queryKey: lfgKeys.panels() }); }
      else setConflict(true);
    } catch (cause) { setError(describeError(cause, 'LFG settings could not be saved.')); }
    finally { setSaving(false); }
  };

  return <section aria-label="LFG settings" className="flex flex-col gap-4 rounded-lg border border-line p-4">
    <header className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold text-fg">LFG settings</h3>
      <p className="text-xs text-fg-muted">Members press the panel button in an LFG channel, fill in a short form and get a card others can join. There is no cap on players.</p>
    </header>
    {conflict && <div role="alert" className="flex flex-col gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <span><b>Settings changed elsewhere.</b> Version {saved.version} is saved now; your edits are still shown. Save again to replace it, or undo.</span>
    </div>}
    <Field label="LFG enabled" inline><Switch checked={value.enabled} disabled={disabled} onCheckedChange={enabled => set({ enabled })} /></Field>

    <section aria-label="LFG channels" className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h4 className="flex-1 text-[13px] font-medium text-fg">Channels ({value.channels.length}/{L.channels})</h4>
        {!disabled && <Button size="sm" icon={<Plus />} disabled={value.channels.length >= L.channels}
          onClick={() => set({ channels: [...value.channels, { channelId: '', panel: null, games: [], pingRoleId: null, voiceChannelIds: null }] })}>Add channel</Button>}
      </header>
      <ul className="flex flex-col gap-2">
        {value.channels.map((channel, index) => <ChannelRow key={index} index={index} value={channel} settings={value} disabled={disabled}
          onChange={next => set({ channels: value.channels.map((item, at) => at === index ? next : item) })}
          onRemove={() => set({ channels: value.channels.filter((_, at) => at !== index) })} />)}
        {!value.channels.length && <li className="text-xs text-fg-subtle">No LFG channel yet.</li>}
      </ul>
    </section>

    <section aria-label="Games" className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h4 className="flex-1 text-[13px] font-medium text-fg">Games ({value.games.length}/{L.games})</h4>
        {!disabled && <Button size="sm" icon={<Plus />} disabled={value.games.length >= L.games}
          onClick={() => set({ games: [...value.games, { name: '', emoji: null, pingRoleId: null }] })}>Add game</Button>}
      </header>
      {!value.games.length && <p className="text-xs text-fg-subtle">No games listed: members type the game themselves.</p>}
      {value.games.map((game, index) => <div key={index} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[2fr_4rem_1.5fr_auto]">
        <Input aria-label={`Game ${index + 1} name`} placeholder="Game name" maxLength={L.gameNameLength} value={game.name} disabled={disabled}
          onChange={event => set({ games: value.games.map((item, at) => at === index ? { ...item, name: event.target.value } : item),
            // Renaming a game keeps the channels that allowed it.
            channels: value.channels.map(channel => ({ ...channel, games: channel.games.map(name => name === game.name ? event.target.value : name) })) })} />
        <Input aria-label={`Game ${index + 1} emoji`} placeholder="🎮" value={game.emoji ?? ''} disabled={disabled}
          onChange={event => set({ games: value.games.map((item, at) => at === index ? { ...item, emoji: event.target.value.trim() || null } : item) })} />
        <RoleSelect value={game.pingRoleId} disabled={disabled} placeholder="Ping role (optional)"
          onChange={pingRoleId => set({ games: value.games.map((item, at) => at === index ? { ...item, pingRoleId } : item) })} />
        {!disabled && <IconButton aria-label={`Remove game ${index + 1}`} icon={<Trash2 />} variant="ghost" size="sm"
          onClick={() => set({ games: value.games.filter((_, at) => at !== index),
            channels: value.channels.map(channel => ({ ...channel, games: channel.games.filter(name => name !== game.name) })) })} />}
      </div>)}
    </section>

    <ListEditor label="Formats" items={value.formats} max={L.formats} disabled={disabled} placeholder="Standard" onChange={formats => set({ formats })} />

    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Card closes after (minutes)" description={`${L.expiryMinutesMin}-${L.expiryMinutesMax}.`}>
        <Input type="number" min={L.expiryMinutesMin} max={L.expiryMinutesMax} value={value.expiryMinutes} disabled={disabled}
          onChange={event => set({ expiryMinutes: Number(event.target.value) })} /></Field>
      <Field label="Post cooldown (minutes)" description="0 for none.">
        <Input type="number" min={0} max={L.cooldownMinutesMax} value={value.cooldownMinutes} disabled={disabled}
          onChange={event => set({ cooldownMinutes: Number(event.target.value) })} /></Field>
      <Field label="Open posts per member" description="0 = unlimited.">
        <Input type="number" min={0} max={L.maxOpenPerUserMax} value={value.maxOpenPerUser} disabled={disabled}
          onChange={event => set({ maxOpenPerUser: Number(event.target.value) })} /></Field>
      <Field label="Ping role" description="Pinged when a card is posted; a game or channel role wins.">
        <RoleSelect value={value.pingRoleId} disabled={disabled} placeholder="No ping" onChange={pingRoleId => set({ pingRoleId })} /></Field>
      <Field label="Ping cooldown (minutes)" description="Per role; 0 for none.">
        <Input type="number" min={0} max={L.pingCooldownMinutesMax} value={value.pingCooldownMinutes} disabled={disabled}
          onChange={event => set({ pingCooldownMinutes: Number(event.target.value) })} /></Field>
      <Field label="Names shown on a card" description={`Then "+N more". ${L.playerListLimitMin}-${L.playerListLimitMax}; every joiner is kept.`}>
        <Input type="number" min={L.playerListLimitMin} max={L.playerListLimitMax} value={value.playerListLimit} disabled={disabled}
          onChange={event => set({ playerListLimit: Number(event.target.value) })} /></Field>
    </div>
    <Field label="Voice rooms" description="Optional existing voice rooms members may pick in the form."><VoiceList label="Voice rooms" value={value.voiceChannelIds}
      disabled={disabled} onChange={voiceChannelIds => set({ voiceChannelIds })} /></Field>

    <section aria-label="Panel" className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium text-fg">Panel (default for every channel)</h4>
      <PanelEditor label="Panel" value={value.panel} disabled={disabled} onChange={panel => set({ panel })} />
    </section>

    <section aria-label="Form" className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium text-fg">Form</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(value.form) as Array<keyof LfgSettingsBodyDto['form']>).map(key => <Field key={key} label={`Form ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`}>
          <Input value={value.form[key]} disabled={disabled} maxLength={key === 'title' ? L.modalTitleLength : key.endsWith('Label') ? L.modalLabelLength : L.modalPlaceholderLength}
            onChange={event => set({ form: { ...value.form, [key]: event.target.value } })} />
        </Field>)}
      </div>
    </section>

    <section aria-label="Messages" className="grid gap-4 xl:grid-cols-2">
      <div className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium text-fg">Messages</h4>
        <p className="text-xs text-fg-muted">Placeholders: {LFG_PLACEHOLDERS.map(name => `{${name}}`).join(' ')}; the ping text also takes {'{role}'}.
          Member text is shown as typed (no formatting, no pings).</p>
        {TEMPLATES.map(([key, label, multiline]) => <Field key={key} label={label}>
          {multiline ? <Textarea rows={key === 'cardBody' ? 5 : 2} value={value.messages[key] as string} disabled={disabled}
            onChange={event => setMessages({ [key]: event.target.value })} />
            : <Input value={value.messages[key] as string} disabled={disabled} onChange={event => setMessages({ [key]: event.target.value })} />}
        </Field>)}
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Join label"><Input value={value.messages.joinLabel} disabled={disabled} onChange={event => setMessages({ joinLabel: event.target.value })} /></Field>
          <Field label="Leave label"><Input value={value.messages.leaveLabel} disabled={disabled} onChange={event => setMessages({ leaveLabel: event.target.value })} /></Field>
          <Field label="Close label"><Input value={value.messages.closeLabel} disabled={disabled} onChange={event => setMessages({ closeLabel: event.target.value })} /></Field>
          <Field label="Card colour"><ColorInput label="Card colour" value={value.messages.cardColor} disabled={disabled}
            onChange={cardColor => setMessages({ cardColor })} /></Field>
        </div>
        {!disabled && <Button size="sm" variant="ghost" onClick={() => set({ messages: structuredClone(DEFAULT_LFG_SETTINGS.messages) })}>Reset messages to defaults</Button>}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium text-fg">Preview</h4>
        <DiscordPreview label="Card preview" content={value.pingRoleId ? renderLfgTemplate(value.messages.pingText, values) : null}
          embed={cardEmbed(value.messages.cardBody, true)} buttons={cardButtons} />
        <DiscordPreview label="Closed card preview" content={null} embed={cardEmbed(value.messages.closedText, false)} buttons={cardButtons} />
        <ul aria-label="Private replies preview" className="flex flex-col gap-1 rounded-md bg-surface-sunken p-2 text-xs text-fg">
          <li>Posted: {renderLfgTemplate(value.messages.postedText, values)}</li>
          <li>Joined: {renderLfgTemplate(value.messages.joinedText, values)}</li>
          <li>Left: {renderLfgTemplate(value.messages.leftText, values)}</li>
        </ul>
      </div>
    </section>

    {problems.length > 0 && <ul aria-label="Problems" className="list-disc pl-4 text-xs text-danger">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
    {canEdit && <footer className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs">
        {error ? <span role="alert" className="text-danger">{error}</span>
          : <span className="text-fg-subtle">Version {saved.version}{dirty ? ' · unsaved changes' : ''}</span>}
      </span>
      <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => { setDraft(null); setConflict(false); setError(null); }}>Undo</Button>
      <Button variant="primary" size="sm" loading={saving} disabled={!dirty || problems.length > 0} onClick={() => { void save(); }}>Save</Button>
    </footer>}
  </section>;
}

function Panels() {
  const panels = useLfgPanels();
  const meta = useGuildMeta();
  const canEdit = useAdminToolsCapability('server.manage');
  const { refreshPanels } = useLfgPostMutations();
  const name = (id: string) => meta.data?.channels.find(channel => channel.id === id)?.name ?? id;
  const tone = (state: string): Tone => state === 'posted' ? 'success' : state === 'waiting' || state === 'disabled' ? 'neutral' : 'danger';
  return <section aria-label="LFG panels" className="flex flex-col gap-2 rounded-lg border border-line p-4">
    <header className="flex items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Panels</h3>
      {canEdit && <Button size="sm" icon={<RefreshCw />} loading={refreshPanels.isPending} onClick={() => refreshPanels.mutate()}>Post / refresh panels</Button>}
    </header>
    {refreshPanels.error && <p role="alert" className="text-xs text-danger">{describeError(refreshPanels.error, 'The panels could not be posted.')}</p>}
    <ul className="flex flex-col gap-1 text-xs">
      {(panels.data?.panels ?? []).map(panel => <li key={panel.channelId} className="flex items-center gap-2">
        <span className="font-medium text-fg">#{name(panel.channelId)}</span><Badge tone={tone(panel.state)}>{panel.state}</Badge>
        {panel.message && <span className="text-fg-muted">{panel.message}</span>}
      </li>)}
      {panels.data && !panels.data.panels.length && <li className="text-fg-subtle">No LFG channel yet.</li>}
    </ul>
  </section>;
}

function Stats() {
  const [days, setDays] = useState(30);
  const stats = useLfgStats(days);
  return <section aria-label="LFG stats" className="flex flex-col gap-2 rounded-lg border border-line p-4">
    <header className="flex items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Stats</h3>
      <SegmentedControl label="Stats period" value={String(days)} onChange={next => setDays(Number(next))}
        options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
    </header>
    {stats.data && <>
      <p className="text-xs text-fg">{stats.data.posts} posts · {stats.data.joins} joins · {stats.data.open} open</p>
      <table className="text-left text-xs">
        <thead><tr className="text-fg-muted"><th>Game</th><th>Posts</th><th>Joins</th><th>Open</th></tr></thead>
        <tbody>{stats.data.games.map(game => <tr key={game.game}><td>{game.game}</td><td>{game.posts}</td><td>{game.joins}</td><td>{game.open}</td></tr>)}</tbody>
      </table>
    </>}
  </section>;
}

function Posts() {
  const [status, setStatus] = useState<LfgPostFilter>('active');
  const [game, setGame] = useState<string | null>(null);
  const posts = useLfgPosts(status, game);
  const settings = useLfgSettings();
  const meta = useGuildMeta();
  const canModerate = useAdminToolsCapability('members.moderate');
  const { close, remove } = useLfgPostMutations();
  const [deleting, setDeleting] = useState<LfgPostDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const member = (id: string) => `@${id.slice(-4)}`;
  const channel = (id: string) => meta.data?.channels.find(item => item.id === id)?.name ?? id;
  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try { await run(); } catch (cause) { setError(describeError(cause, fallback)); }
  };
  return <section aria-label="LFG posts" className="flex flex-col gap-2 rounded-lg border border-line p-4">
    <header className="flex flex-wrap items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Posts</h3>
      <SegmentedControl label="Post status" value={status} onChange={setStatus}
        options={[{ value: 'active', label: 'Active' }, { value: 'closed', label: 'Closed' }, { value: 'expired', label: 'Expired' },
          { value: 'deleted', label: 'Deleted' }, { value: 'all', label: 'All' }]} />
      <Select aria-label="Game filter" value={game ?? ''} onChange={event => setGame(event.target.value || null)}>
        <option value="">All games</option>
        {(settings.data?.games ?? []).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </Select>
    </header>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {posts.error ? <p role="alert" className="text-xs text-danger">{describeError(posts.error, 'Posts could not be loaded.')}</p> : null}
    {posts.data && !posts.data.posts.length && <EmptyState icon={<Gamepad2 />} title="No posts" description="Nothing matches these filters." />}
    <ul className="flex flex-col gap-2">
      {(posts.data?.posts ?? []).map(item => <li key={item.id} aria-label={`Post ${item.game} by ${member(item.authorId)}`}
        className="flex flex-col gap-1 rounded-md border border-line p-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{item.game}{item.format ? ` · ${item.format}` : ''}</span>
          <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge>
          <span className="text-fg-muted">#{channel(item.channelId)} · {member(item.authorId)} · {item.players.length + 1} players · {time(item.createdAtMs)}</span>
          <span className="flex-1" />
          {canModerate && (item.status === 'open' || item.status === 'posting') && <Button size="sm" loading={close.isPending && close.variables === item.id}
            onClick={() => { void act(() => close.mutateAsync(item.id), 'The post could not be closed.'); }}>Close</Button>}
          {canModerate && item.status !== 'deleted' && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(item)}>Delete</Button>}
        </div>
        {item.note && <p className="text-fg-muted">{item.note}</p>}
      </li>)}
    </ul>
    <ConfirmDialog open={deleting !== null} danger title="Delete this post?" confirmLabel="Delete"
      description="The card is removed from Discord. The post stays in the stats." pending={remove.isPending}
      onCancel={() => setDeleting(null)}
      onConfirm={() => { const target = deleting; setDeleting(null); if (target) void act(() => remove.mutateAsync(target.id), 'The post could not be deleted.'); }} />
  </section>;
}

export function LfgTab() {
  return <div className="flex flex-col gap-4">
    <LfgSettingsEditor />
    <Panels />
    <Posts />
    <Stats />
  </div>;
}
