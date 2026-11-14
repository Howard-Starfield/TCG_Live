// Keyword filter settings (Discord AutoMod): preset lists, custom lists, actions, alert channel,
// exemptions, and a manual "Sync now" that reports how Discord took the rules.
import { KEYWORD_PRESETS, MODERATION_LIMITS as L, type AutoModSyncResultDto, type CustomKeywordListDto,
  type KeywordAction, type KeywordPreset, type TextModerationSettingsDto } from '@tcg-live/core';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, useAdminData } from '../../data';
import { Button, Disclosure, Field, Input, Select, Switch } from '../../ui';
import { describeError } from '../evidence/api';
import { syncAutoMod } from './api';
import { ChipInput, IdListInput } from './ChipInput';
import { listIdFor, type SettingsErrors } from './validate';

const PRESET_LABEL: Record<KeywordPreset, string> = { profanity: 'Profanity', sexual: 'Sexual content', slurs: 'Slurs' };
const ACTION_LABEL: Record<KeywordAction, string> = { flag: 'Flag only (alert)', block: 'Block message', timeout: 'Block and time out' };
const TIMEOUT_PRESETS = [60, 300, 600, 3600, 86_400, 604_800, L.timeoutSecondsMax] as const;

export function timeoutLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function CustomList({ list, index, errors, disabled, onChange, onRemove }: {
  list: CustomKeywordListDto; index: number; errors: SettingsErrors; disabled: boolean;
  onChange(next: CustomKeywordListDto): void; onRemove(): void;
}) {
  const base = `text.customLists.${index}`;
  const set = <K extends keyof CustomKeywordListDto>(key: K, value: CustomKeywordListDto[K]) => onChange({ ...list, [key]: value });
  return <section aria-label={`Custom list ${list.name || index + 1}`} className="flex flex-col gap-3 rounded-lg bg-raised p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
    <div className="flex items-end gap-2">
      <Field label="List name" error={errors[`${base}.name`]} className="flex-1">
        <Input value={list.name} maxLength={L.listNameLength + 10} disabled={disabled} onChange={event => set('name', event.target.value)} />
      </Field>
      <Switch aria-label={`Use list ${list.name || index + 1}`} checked={list.enabled} disabled={disabled} onCheckedChange={value => set('enabled', value)} />
      <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} disabled={disabled} onClick={onRemove}
        aria-label={`Remove list ${list.name || index + 1}`}>Remove</Button>
    </div>
    <Field label="Words" description={`Up to ${L.wordsPerList} words of ${L.wordLength} characters. Use * for wildcards, as in Discord.`}
      error={errors[`${base}.words`]}>
      <ChipInput label={`Words in ${list.name || 'list'}`} values={list.words} max={L.wordsPerList} disabled={disabled} onChange={value => set('words', value)} />
    </Field>
    <Field label="Regex patterns" description={`Up to ${L.regexPerList} patterns of ${L.regexLength} characters. Discord uses Rust regex syntax.`}
      error={errors[`${base}.regexPatterns`]}>
      <ChipInput label={`Patterns in ${list.name || 'list'}`} values={list.regexPatterns} max={L.regexPerList} mono disabled={disabled}
        onChange={value => set('regexPatterns', value)} placeholder="Type a pattern and press Enter" />
    </Field>
    <Field label="Allow list" description="Words that never trigger this list." error={errors[`${base}.allowList`]}>
      <ChipInput label={`Allowed in ${list.name || 'list'}`} values={list.allowList} max={L.allowListPerCustomList} disabled={disabled}
        onChange={value => set('allowList', value)} />
    </Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Action">
        <Select value={list.action} disabled={disabled} onChange={event => set('action', event.target.value as KeywordAction)}>
          {(['flag', 'block', 'timeout'] as const).map(action => <option key={action} value={action}>{ACTION_LABEL[action]}</option>)}
        </Select>
      </Field>
      {list.action === 'timeout' && <Field label="Timeout" error={errors[`${base}.timeoutSeconds`]}>
        <Select value={String(list.timeoutSeconds)} disabled={disabled} onChange={event => set('timeoutSeconds', Number(event.target.value))}>
          {[...new Set([...TIMEOUT_PRESETS, list.timeoutSeconds])].sort((a, b) => a - b)
            .map(seconds => <option key={seconds} value={seconds}>{timeoutLabel(seconds)}</option>)}
        </Select>
      </Field>}
    </div>
  </section>;
}

function SyncStatus({ result, error }: { result: AutoModSyncResultDto | null; error: unknown }) {
  if (error) {
    const permission = error instanceof ApiError && (error.status === 403 || /permission/i.test(error.message));
    return <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger p-2 text-xs text-danger">
      <span>{describeError(error, 'Sync failed.')}</span>
      {permission && <span className="text-fg-muted">Repair: in Discord, give the bot's role the <b>Manage Server</b> permission (AutoMod rules need it), then sync again.</span>}
    </div>;
  }
  if (!result) return null;
  const text = result.status === 'synced' ? `Synced to Discord (${result.ruleIds.length} rule${result.ruleIds.length === 1 ? '' : 's'}).`
    : result.status === 'pending' ? 'Discord has not taken the rules yet; the bot retries when it reconnects.'
      : 'The filter is off, so the bot\'s Discord rules are disabled.';
  return <div role="status" className="flex flex-col gap-1 rounded-md bg-sunken p-2 text-xs text-fg-muted">
    <span>{text}</span>
    {result.presetManagedElsewhere && <span className="text-warning">Preset lists are managed elsewhere: this server already has its own preset rule (Discord allows one), so only your custom lists are managed here.</span>}
    {result.message && <span>{result.message}</span>}
    {result.status === 'pending' && /permission/i.test(result.message ?? '') &&
      <span>Repair: give the bot's role the <b>Manage Server</b> permission in Discord, then sync again.</span>}
  </div>;
}

export function KeywordSection({ text, onChange, errors, disabled, dirty }: {
  text: TextModerationSettingsDto; onChange(next: TextModerationSettingsDto): void; errors: SettingsErrors; disabled: boolean; dirty: boolean;
}) {
  const { api } = useAdminData();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<AutoModSyncResultDto | null>(null);
  const [syncError, setSyncError] = useState<unknown>(null);
  const set = <K extends keyof TextModerationSettingsDto>(key: K, value: TextModerationSettingsDto[K]) => onChange({ ...text, [key]: value });
  const preset = text.preset;
  const off = disabled || !text.enabled;

  const sync = async () => {
    setSyncing(true); setSyncError(null); setResult(null);
    try { setResult(await syncAutoMod(api)); } catch (error) { setSyncError(error); } finally { setSyncing(false); }
  };
  const addList = () => {
    const name = `Custom list ${text.customLists.length + 1}`;
    set('customLists', [...text.customLists, { id: listIdFor(name, text.customLists.map(list => list.id)), name, enabled: true,
      words: [], regexPatterns: [], allowList: [], action: 'block', timeoutSeconds: 600 }]);
  };

  return <div className="flex flex-col gap-4">
    <Field label="Keyword filter" inline description="Uses Discord AutoMod: blocked messages never appear, even while this PC is off.">
      <Switch checked={text.enabled} disabled={disabled} onCheckedChange={value => set('enabled', value)} />
    </Field>

    <section aria-label="Preset lists" className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-fg">Discord preset lists</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {KEYWORD_PRESETS.map(name => <Field key={name} label={PRESET_LABEL[name]} inline>
          <Switch checked={preset.enabled && preset.presets[name]} disabled={off}
            onCheckedChange={value => {
              const presets = { ...preset.presets, [name]: value };
              set('preset', { ...preset, presets, enabled: Object.values(presets).some(Boolean) });
            }} />
        </Field>)}
      </div>
      <Field label="Preset action" description="Discord does not allow a timeout on preset lists." error={errors['text.preset.action']}>
        <Select value={preset.action} disabled={off} onChange={event => set('preset', { ...preset, action: event.target.value as 'flag' | 'block' })}>
          <option value="flag">{ACTION_LABEL.flag}</option>
          <option value="block">{ACTION_LABEL.block}</option>
        </Select>
      </Field>
      {errors['text.preset.presets'] && <p role="alert" className="text-xs text-danger">{errors['text.preset.presets']}</p>}
      <Field label="Preset allow list" description={`Words that never trigger the presets (up to ${L.allowListPreset}).`} error={errors['text.preset.allowList']}>
        <ChipInput label="Preset allow list" values={preset.allowList} max={L.allowListPreset} disabled={off}
          onChange={value => set('preset', { ...preset, allowList: value })} />
      </Field>
    </section>

    <section aria-label="Custom word lists" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-fg">Custom word lists <span className="font-normal text-fg-subtle">({text.customLists.length} / {L.customLists})</span></h3>
        <Button size="sm" icon={<Plus aria-hidden />} disabled={off || text.customLists.length >= L.customLists} onClick={addList}>Add list</Button>
      </div>
      {errors['text.customLists'] && <p role="alert" className="text-xs text-danger">{errors['text.customLists']}</p>}
      {text.customLists.length === 0 && <p className="text-xs text-fg-muted">No custom lists. Add one for words specific to your community.</p>}
      {text.customLists.map((list, index) => <CustomList key={list.id} list={list} index={index} errors={errors} disabled={off}
        onChange={next => set('customLists', text.customLists.map((item, at) => (at === index ? next : item)))}
        onRemove={() => set('customLists', text.customLists.filter((_, at) => at !== index))} />)}
    </section>

    <Field label="Alert channel ID" description={'AutoMod posts an alert here when a rule fires. Required for "Flag only" rules; flags also appear in the dashboard.'}
      error={errors['text.alertChannelId']}>
      <Input value={text.alertChannelId ?? ''} inputMode="numeric" disabled={off} className="font-mono"
        onChange={event => set('alertChannelId', event.target.value.trim() || null)} />
    </Field>
    <Field label="Message shown when blocked" description={`Up to ${L.blockMessageLength} characters.`} error={errors['text.blockMessage']}>
      <Input value={text.blockMessage} disabled={off} onChange={event => set('blockMessage', event.target.value)} />
    </Field>
    <Disclosure summary="Exempt channels and roles" meta={`${text.exemptChannelIds.length + text.exemptRoleIds.length} exempt`}>
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-xs text-fg-muted">AutoMod can only exempt channels; to filter match rooms only, exempt every other channel.</p>
        <Field label="Exempt channel IDs" error={errors['text.exemptChannelIds']}>
          <IdListInput label="Exempt channels" values={text.exemptChannelIds} max={L.exemptChannels} disabled={off}
            onChange={value => set('exemptChannelIds', value)} />
        </Field>
        <Field label="Exempt role IDs" error={errors['text.exemptRoleIds']}>
          <IdListInput label="Exempt roles" values={text.exemptRoleIds} max={L.exemptRoles} disabled={off}
            onChange={value => set('exemptRoleIds', value)} />
        </Field>
      </div>
    </Disclosure>

    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <Button size="sm" icon={<RefreshCw aria-hidden />} loading={syncing} disabled={disabled} onClick={() => void sync()}>Sync now</Button>
        <span className="text-2xs text-fg-subtle">{dirty ? 'Save first: sync sends the saved settings.' : 'Saving also syncs; use this to retry.'}</span>
      </div>
      <SyncStatus result={result} error={syncError} />
    </div>
  </div>;
}
