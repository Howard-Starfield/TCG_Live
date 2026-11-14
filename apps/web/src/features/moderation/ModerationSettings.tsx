// Moderation & evidence settings, opened from the account menu. Saves with optimistic concurrency: a
// 409 loads the fresh server state and keeps the admin's edits aside so they can be reapplied.
import type { ModerationSettingsBodyDto, ModerationSettingsDto } from '@tcg-live/core';
import { useEffect, useMemo, useState } from 'react';
import { useAdminData } from '../../data';
import { Button, Dialog, TabPanel, TabStrip } from '../../ui';
import { describeError, isNotAvailable } from '../evidence/api';
import { getModerationSettings, saveModerationSettings, useModerationAccess } from './api';
import { KeywordSection } from './KeywordSection';
import { VoiceBots } from './VoiceBots';
import { RecordingSection, VolumeSection } from './VoiceSections';
import { validateSettings } from './validate';

type Section = 'keywords' | 'volume' | 'recording' | 'bots';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'keywords', label: 'Keyword filter' },
  { value: 'volume', label: 'Volume flags' },
  { value: 'recording', label: 'Recording' },
  { value: 'bots', label: 'Voice bots' }
];
const SECTION_OF: Record<string, Section> = { text: 'keywords', voice: 'volume', recording: 'recording', retention: 'recording', noticeText: 'recording' };

export function bodyOf(settings: ModerationSettingsDto): ModerationSettingsBodyDto {
  const { text, voice, recording, retention, noticeText } = settings;
  return { text, voice, recording, retention, noticeText };
}

export function ModerationSettings({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api } = useAdminData();
  const allowed = useModerationAccess();
  const [saved, setSaved] = useState<ModerationSettingsDto | null>(null);
  const [draft, setDraft] = useState<ModerationSettingsBodyDto | null>(null);
  const [stash, setStash] = useState<ModerationSettingsBodyDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [section, setSection] = useState<Section>('keywords');

  useEffect(() => {
    if (!open || !allowed) return;
    let live = true;
    const abort = new AbortController();
    setLoadError(null); setSaveError(null); setMessage(null); setStash(null); setAttempted(false);
    getModerationSettings(api, abort.signal).then(next => {
      if (!live) return;
      setSaved(next); setDraft(bodyOf(next));
    }).catch(cause => { if (live && !abort.signal.aborted) setLoadError(cause); });
    return () => { live = false; abort.abort(); };
  }, [allowed, api, open]);

  const errors = useMemo(() => (draft ? validateSettings(draft) : {}), [draft]);
  const errorCount = Object.keys(errors).length;
  const dirty = Boolean(saved && draft && JSON.stringify(bodyOf(saved)) !== JSON.stringify(draft));
  const sectionErrors = (value: Section) => Object.keys(errors).some(path => SECTION_OF[path.split('.')[0]!] === value);

  const save = async () => {
    setAttempted(true);
    if (!saved || !draft || saving) return;
    if (errorCount > 0) {
      setSaveError(`Fix ${errorCount} problem${errorCount === 1 ? '' : 's'} before saving.`);
      const first = SECTIONS.find(item => sectionErrors(item.value));
      if (first) setSection(first.value);
      return;
    }
    setSaving(true); setSaveError(null); setMessage(null);
    try {
      const result = await saveModerationSettings(api, saved.version, draft);
      if (result.ok) {
        setSaved(result.settings); setDraft(bodyOf(result.settings)); setStash(null); setAttempted(false);
        setMessage('Saved. Discord rules sync in the background; use Sync now on the Keyword filter tab to check.');
      } else {
        // Someone else saved first: show their state, keep ours aside for an explicit reapply.
        setStash(draft);
        setSaved(result.conflict); setDraft(bodyOf(result.conflict));
      }
    } catch (cause) {
      setSaveError(describeError(cause, 'Settings could not be saved.'));
    } finally { setSaving(false); }
  };

  const disabled = saving || !draft;
  const tabs = SECTIONS.map(item => ({ value: item.value, label: item.label,
    ...(attempted && sectionErrors(item.value) ? { badge: <span aria-label="has problems" className="size-1.5 rounded-full bg-danger" /> } : {}) }));

  let body;
  if (!allowed) body = <p className="text-xs text-fg-muted">This session cannot change moderation settings.</p>;
  else if (loadError) body = <p role="alert" className="text-xs text-danger">{isNotAvailable(loadError)
    ? 'Moderation settings are not available in this version yet.' : describeError(loadError, 'Settings could not be loaded.')}</p>;
  else if (!draft) body = <p role="status" className="text-xs text-fg-muted">Loading settings…</p>;
  // A fixed body height with the panel scrolling inside keeps the tab row in place when tabs differ in length.
  else body = <div className="flex h-[min(440px,calc(100vh-260px))] min-h-[240px] flex-col gap-3" data-testid="moderation-body">
    {stash && <div role="alert" className="flex flex-col gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <span><b>Settings changed elsewhere.</b> The latest saved settings are loaded below. Your edits were kept aside, not saved.</span>
      <span className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => { setDraft(stash); setStash(null); }}>Reapply my edits</Button>
        <Button size="sm" variant="ghost" onClick={() => setStash(null)}>Discard my edits</Button>
      </span>
    </div>}
    <TabStrip<Section> label="Moderation sections" idBase="moderation" tabs={tabs} value={section} onChange={setSection}
      className="w-max max-w-full shrink-0 overflow-x-auto overflow-y-hidden rounded-[9px] bg-line-faint p-0.5" />
    <TabPanel idBase="moderation" value={section} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 pt-1">
      {section === 'keywords' && <KeywordSection text={draft.text} errors={attempted ? errors : liveErrors(errors)} disabled={disabled} dirty={dirty}
        onChange={text => setDraft({ ...draft, text })} />}
      {section === 'volume' && <VolumeSection voice={draft.voice} errors={errors} disabled={disabled}
        onChange={voice => setDraft({ ...draft, voice })} />}
      {section === 'recording' && <RecordingSection settings={draft} errors={errors} disabled={disabled} onChange={setDraft} />}
      {section === 'bots' && <VoiceBots disabled={saving} />}
    </TabPanel>
  </div>;

  return <Dialog open={open} onClose={onClose} title="Moderation & evidence" width="xl" dismissible={!saving}
    description="Keyword filter, volume flags, voice recording and the voice bot pool for this Discord server."
    footer={<div className="flex w-full items-center gap-2">
      <span className="min-w-0 flex-1 text-xs">
        {saveError && <span role="alert" className="text-danger">{saveError}</span>}
        {!saveError && message && <span role="status" className="text-fg-muted">{message}</span>}
        {!saveError && !message && saved && <span className="text-fg-subtle">Version {saved.version}{dirty ? ' · unsaved changes' : ''}</span>}
      </span>
      <Button variant="ghost" onClick={onClose} disabled={saving}>{dirty ? 'Cancel' : 'Close'}</Button>
      {allowed && draft && <Button variant="primary" loading={saving} disabled={!dirty && !stash} onClick={() => void save()}>Save</Button>}
    </div>}>
    {body}
  </Dialog>;
}

/** Before the first save attempt, show only limit overruns that cannot be fixed later by adding content. */
function liveErrors(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => !message.startsWith('Add at least') && !message.startsWith('Give the list')));
}
