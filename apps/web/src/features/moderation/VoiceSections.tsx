// Volume flag and recording settings. The bot never mutes anyone: loud moments are only flagged.
import { DEFAULT_MODERATION_NOTICE, EVIDENCE_QUOTA_BYTES, MODERATION_LIMITS as L, RETENTION_PRESET_DAYS,
  VOICE_SENSITIVITY_PRESETS, type ModerationSettingsBodyDto, type RecordingMode, type VoiceLoudnessSettingsDto,
  type VoiceMonitorScope, type VoiceSensitivity } from '@tcg-live/core';
import { TriangleAlert, UserX, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Disclosure, Field, Input, SegmentedControl, Select, Switch, Textarea } from '../../ui';
import { formatBytes } from '../evidence/api';
import type { SettingsErrors } from './validate';

type Preset = Exclude<VoiceSensitivity, 'custom'>;

function Slider({ label, value, min, max, step, unit, error, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string; error: string | undefined;
  disabled: boolean; onChange(value: number): void;
}) {
  return <Field label={label} description={`${min} to ${max} ${unit}`} error={error}>
    <div className="flex items-center gap-2">
      <input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))}
        disabled={disabled} onChange={event => onChange(Number(event.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
      <Input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} disabled={disabled}
        onChange={event => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))} className="w-24 font-mono" />
    </div>
  </Field>;
}

export function VolumeSection({ voice, onChange, errors, disabled }: {
  voice: VoiceLoudnessSettingsDto; onChange(next: VoiceLoudnessSettingsDto): void; errors: SettingsErrors; disabled: boolean;
}) {
  const set = <K extends keyof VoiceLoudnessSettingsDto>(key: K, value: VoiceLoudnessSettingsDto[K]) => onChange({ ...voice, [key]: value });
  const off = disabled || !voice.enabled;
  const choosePreset = (preset: Preset) => onChange({ ...voice, sensitivity: preset, ...VOICE_SENSITIVITY_PRESETS[preset] });
  const advanced = (patch: Partial<VoiceLoudnessSettingsDto>) => onChange({ ...voice, ...patch, sensitivity: 'custom' });
  return <div className="flex flex-col gap-4">
    <Field label="Volume flags" inline description="Flags sustained shouting or loud spikes in match voice rooms. Nobody is muted automatically.">
      <Switch checked={voice.enabled} disabled={disabled} onCheckedChange={value => set('enabled', value)} />
    </Field>
    <Field label="Sensitivity" description={voice.sensitivity === 'custom' ? 'Custom values from Advanced.' : 'Higher flags quieter moments.'}>
      <SegmentedControl<VoiceSensitivity> label="Sensitivity" value={voice.sensitivity}
        onChange={value => { if (value !== 'custom') choosePreset(value); }}
        options={[{ value: 'low', label: 'Low', disabled: off }, { value: 'medium', label: 'Medium', disabled: off },
          { value: 'high', label: 'High', disabled: off }, { value: 'custom', label: 'Custom', disabled: true, title: 'Change Advanced values' }]} />
    </Field>
    <Field label="Where to listen">
      <SegmentedControl<VoiceMonitorScope> label="Monitoring scope" value={voice.scope} onChange={value => set('scope', value)}
        options={[{ value: 'judge-call', label: 'During judge calls', disabled: off }, { value: 'always', label: 'All match rooms', disabled: off }]} />
    </Field>
    <Field label="Notify the organizer in Discord" inline description="A rate-limited message for each flag, besides the dashboard.">
      <Switch checked={voice.notifyDiscord} disabled={off} onCheckedChange={value => set('notifyDiscord', value)} />
    </Field>
    {voice.notifyDiscord && <Field label="Notice channel ID" description="Leave empty to use the signup channel." error={errors['voice.notifyChannelId']}>
      <Input value={voice.notifyChannelId ?? ''} disabled={off} inputMode="numeric" className="font-mono"
        onChange={event => set('notifyChannelId', event.target.value.trim() || null)} />
    </Field>}
    <Disclosure summary="Advanced" meta={`${voice.thresholdDbfs} dBFS · ${voice.sustainMs} ms`}>
      <div className="flex flex-col gap-3 pt-2">
        <Slider label="Threshold (dBFS)" value={voice.thresholdDbfs} min={L.thresholdDbfsMin} max={L.thresholdDbfsMax} step={1} unit="dBFS"
          error={errors['voice.thresholdDbfs']} disabled={off} onChange={value => advanced({ thresholdDbfs: value })} />
        <Slider label="Sustain (ms)" value={voice.sustainMs} min={L.sustainMsMin} max={L.sustainMsMax} step={50} unit="ms"
          error={errors['voice.sustainMs']} disabled={off} onChange={value => advanced({ sustainMs: value })} />
        <Slider label="Cooldown (ms)" value={voice.cooldownMs} min={L.cooldownMsMin} max={L.cooldownMsMax} step={1000} unit="ms"
          error={errors['voice.cooldownMs']} disabled={off} onChange={value => onChange({ ...voice, cooldownMs: value })} />
      </div>
    </Disclosure>
  </div>;
}

type RetentionChoice = '7' | '30' | 'never' | 'custom';
const retentionChoice = (days: number | null): RetentionChoice =>
  days === null ? 'never' : (RETENTION_PRESET_DAYS as readonly (number | null)[]).includes(days) ? String(days) as RetentionChoice : 'custom';

export function RecordingSection({ settings, onChange, errors, disabled }: {
  settings: ModerationSettingsBodyDto; onChange(next: ModerationSettingsBodyDto): void; errors: SettingsErrors; disabled: boolean;
}) {
  const choice = retentionChoice(settings.retention.days);
  const setDays = (days: number | null) => onChange({ ...settings, retention: { days } });
  return <div className="flex flex-col gap-4">
    <p className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>Players are told when recording is active: signup cards and match rooms show the notice below. Recording people without telling them is illegal in many places.</span>
    </p>
    <Field label="Record match voice">
      <SegmentedControl<RecordingMode> label="Recording mode" value={settings.recording.mode}
        onChange={mode => onChange({ ...settings, recording: { ...settings.recording, mode } })}
        options={[{ value: 'off', label: 'Off', disabled }, { value: 'judge-call', label: 'On judge call', disabled },
          { value: 'always', label: 'Always', disabled }]} />
    </Field>
    <p className="-mt-2 text-2xs text-fg-subtle">Audio only, one file per player, stored on this PC. Video is never recorded by the bot.</p>
    <OptOutList ids={settings.recording.optOutUserIds ?? []} disabled={disabled}
      onChange={optOutUserIds => onChange({ ...settings, recording: { ...settings.recording, optOutUserIds } })} />
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Keep evidence for" description="Held items are never deleted automatically.">
        <Select value={choice} disabled={disabled} onChange={event => {
          const value = event.target.value as RetentionChoice;
          setDays(value === 'never' ? null : value === 'custom' ? (settings.retention.days ?? 14) : Number(value));
        }}>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="never">Never delete</option>
          <option value="custom">Custom…</option>
        </Select>
      </Field>
      {choice === 'custom' && <Field label="Days" error={errors['retention.days']}>
        <Input type="number" min={L.retentionDaysMin} max={L.retentionDaysMax} step={1} disabled={disabled}
          value={settings.retention.days ?? ''} onChange={event => setDays(event.target.value === '' ? Number.NaN : Number(event.target.value))} />
      </Field>}
    </div>
    <p className="text-xs text-fg-muted">Storage quota: {formatBytes(EVIDENCE_QUOTA_BYTES)} for all evidence. Evidence files stay on this PC and are not in database backups.</p>
    <Field label="Notice text" description={`Shown while monitoring or recording is active. Up to ${L.noticeTextLength} characters; leave empty for the default.`}
      error={errors.noticeText}>
      <Textarea rows={3} value={settings.noticeText ?? ''} placeholder={DEFAULT_MODERATION_NOTICE} disabled={disabled}
        onChange={event => onChange({ ...settings, noticeText: event.target.value.trim() ? event.target.value : null })} />
    </Field>
  </div>;
}

const SNOWFLAKE = /^[1-9]\d{15,21}$/;

/** Players who declined recording: never subscribed, recorded or loudness-checked. Saved with the settings. */
export function OptOutList({ ids, disabled, onChange }: { ids: string[]; disabled: boolean; onChange(ids: string[]): void }) {
  const [value, setValue] = useState('');
  const id = value.trim();
  const error = id && !SNOWFLAKE.test(id) ? 'Paste a Discord user ID (right-click the player, Copy User ID).'
    : ids.length >= L.recordingOptOuts ? `At most ${L.recordingOptOuts} players.` : null;
  const add = () => { if (!id || error) return; if (!ids.includes(id)) onChange([...ids, id]); setValue(''); };
  return <section aria-label="Recording opt-outs" className="flex flex-col gap-2 rounded-md bg-sunken p-2">
    <h4 className="flex items-center gap-1.5 text-xs font-semibold text-fg"><UserX aria-hidden className="size-3.5" />Players who opted out ({ids.length})</h4>
    <p className="text-2xs text-fg-subtle">They are never recorded and their audio is not processed at all. Players can also opt out themselves in Discord. Save to apply.</p>
    {ids.length > 0 && <ul className="flex flex-wrap gap-1.5">{ids.map(item => <li key={item} className="flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-2xs">
      {item}<button type="button" aria-label={`Remove opt-out ${item}`} disabled={disabled} className="text-fg-subtle hover:text-fg"
        onClick={() => onChange(ids.filter(other => other !== item))}><X aria-hidden className="size-3" /></button></li>)}</ul>}
    <div className="flex items-end gap-2">
      <Field label="Discord user ID" error={error}>
        <Input value={value} inputMode="numeric" className="font-mono" disabled={disabled} onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      </Field>
      <Button size="sm" variant="ghost" disabled={disabled || !id || !!error} onClick={add}>Add opt-out</Button>
    </div>
  </section>;
}
