// Rooms tab > Server baseline: the voice channels and categories that are the server's normal layout. Clean-up keeps these
// and restores nothing in them; the bot only ever deletes channels it created, whatever is ticked here.
import type { BaselineChannelDto, MatchRoomsDto } from '@tcg-live/core';
import { useState } from 'react';
import { Badge, Button } from '../../../ui';
import { describeError } from '../../evidence/api';
import { isConflict, useMatchRoomActions } from './api';

const GROUPS: ReadonlyArray<{ type: BaselineChannelDto['type']; title: string }> = [
  { type: 'category', title: 'Categories' }, { type: 'voice', title: 'Voice channels' }, { type: 'stage', title: 'Stage channels' }];
const sameSet = (a: ReadonlySet<string>, b: readonly string[]) => a.size === b.length && b.every(id => a.has(id));

export function BaselineCard({ data, canEdit }: { data: MatchRoomsDto; canEdit: boolean }) {
  const { saveSettings } = useMatchRoomActions();
  const { settings } = data;
  const checkedFromServer = () => new Set(data.baseline.filter(item => item.inBaseline).map(item => item.id));
  const [checked, setChecked] = useState<Set<string>>(checkedFromServer);
  // Only a change to the baseline itself replaces the draft; the other settings card saving must not wipe unsaved ticks.
  const baselineKey = data.baseline.filter(item => item.inBaseline).map(item => item.id).join(',');
  const [seenKey, setSeenKey] = useState(baselineKey);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (seenKey !== baselineKey) { setSeenKey(baselineKey); setChecked(checkedFromServer()); }
  const serverIds = data.baseline.filter(item => item.inBaseline).map(item => item.id);
  const dirty = !sameSet(checked, serverIds);

  const toggle = (id: string, on: boolean) => {
    setSaved(false); setError(null);
    setChecked(current => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  };
  const save = async () => {
    setError(null); setSaved(false);
    try {
      // Only the baseline changes here; the template and category go back exactly as saved, including a category still waiting to be created.
      await saveSettings.mutateAsync({ expectedVersion: settings.version, template: settings.template, categoryId: settings.categoryId,
        createCategory: settings.categoryId === null ? settings.pendingCategoryName : null, baselineChannelIds: [...checked] });
      setSaved(true);
    } catch (cause) {
      setError(isConflict(cause) ? 'The settings changed in another tab. The latest are shown; make your edit again.' : describeError(cause, 'The baseline could not be saved.'));
    }
  };

  return <section aria-label="Server baseline" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold text-fg">Server baseline</h3>
      <p className="text-xs text-fg-muted">These are kept after every tournament. The bot only ever deletes channels it created.</p>
    </header>
    {data.baseline.length === 0 ? <p className="text-xs text-fg-subtle">No voice channels or categories were found.</p>
      : GROUPS.map(group => {
        const items = data.baseline.filter(item => item.type === group.type);
        if (items.length === 0) return null;
        return <fieldset key={group.type} disabled={!canEdit || saveSettings.isPending} className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-fg-muted">{group.title}</legend>
          <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {items.map(item => <li key={item.id}>
              <label className="flex items-center gap-2 text-[13px] text-fg">
                <input type="checkbox" checked={checked.has(item.id)} onChange={event => toggle(item.id, event.target.checked)} />
                <span className="min-w-0 truncate">{item.name}</span>
                {item.botCreated && <Badge tone="accent">bot-created</Badge>}
              </label>
            </li>)}
          </ul>
        </fieldset>;
      })}
    {settings.baselineCapturedAtMs === null && <p className="text-xs text-fg-subtle">The baseline has not been captured yet; the bot captures it at first start.</p>}
    {canEdit && <footer className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs">
        {error ? <span role="alert" className="text-danger">{error}</span>
          : saved ? <span role="status" className="text-fg-muted">Baseline saved.</span>
            : <span className="text-fg-subtle">{checked.size} kept{dirty ? ' · unsaved changes' : ''}</span>}
      </span>
      <Button size="sm" variant="ghost" disabled={!dirty || saveSettings.isPending} onClick={() => setChecked(checkedFromServer())}>Undo</Button>
      <Button size="sm" variant="primary" loading={saveSettings.isPending} disabled={!dirty} onClick={() => { void save(); }}>Save baseline</Button>
    </footer>}
  </section>;
}
