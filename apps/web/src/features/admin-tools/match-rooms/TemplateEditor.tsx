// Rooms tab > Settings: the room name template (presets, validation and a live preview from the core renderer) and the
// category the rooms go in. Saved through the versioned settings route; the server renames the rooms through its queue.
import { MATCH_ROOM_LIMITS, MATCH_ROOM_RENAME_NOTICE, MATCH_ROOM_TEMPLATE_PRESETS, MATCH_ROOM_TEMPLATE_TOKENS,
  renderMatchRoomName, validateMatchRoomTemplate, type MatchId, type MatchRoomsDto } from '@tcg-live/core';
import { useState } from 'react';
import { Button, Field, Input, Select } from '../../../ui';
import { describeError } from '../../evidence/api';
import { isConflict, useMatchRoomActions } from './api';

export const DEFAULT_CATEGORY_NAME = 'TCG Live — Matches';
const NEW_CATEGORY = '__new__';
const PREVIEW_TABLES: readonly number[] = [1, 2, 3];

const savedCategoryOf = (settings: MatchRoomsDto['settings']) => settings.categoryId ?? (settings.pendingCategoryName ? NEW_CATEGORY : '');
const savedNameOf = (settings: MatchRoomsDto['settings']) => settings.pendingCategoryName ?? DEFAULT_CATEGORY_NAME;

export function TemplateEditor({ data, canEdit }: { data: MatchRoomsDto; canEdit: boolean }) {
  const { saveSettings } = useMatchRoomActions();
  const { settings } = data;
  const [template, setTemplate] = useState(settings.template);
  // '' is "no category", NEW_CATEGORY creates one, anything else is a category channel ID.
  const [category, setCategory] = useState(savedCategoryOf(settings));
  const [newName, setNewName] = useState(savedNameOf(settings));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Only a change to this card's own saved fields replaces the drafts; saving the baseline card must not wipe unsaved edits here.
  const ownKey = `${settings.template}\u0000${settings.categoryId}\u0000${settings.pendingCategoryName}`;
  const [seenKey, setSeenKey] = useState(ownKey);
  if (seenKey !== ownKey) {
    setSeenKey(ownKey);
    setTemplate(settings.template); setCategory(savedCategoryOf(settings)); setNewName(savedNameOf(settings));
  }

  const templateError = validateMatchRoomTemplate(template);
  const nameError = category === NEW_CATEGORY && !newName.trim() ? 'Enter a category name.' : null;
  const categories = data.baseline.filter(item => item.type === 'category');
  const dirty = template !== settings.template || category !== savedCategoryOf(settings)
    || (category === NEW_CATEGORY && newName.trim() !== savedNameOf(settings));
  const renamesRooms = template !== settings.template && data.rooms.some(room => room.customName === null);

  const edit = (apply: () => void) => { apply(); setSaved(false); setError(null); };
  const save = async () => {
    setError(null); setSaved(false);
    try {
      await saveSettings.mutateAsync({ expectedVersion: settings.version, template: template.trim(),
        categoryId: category === '' || category === NEW_CATEGORY ? null : category,
        createCategory: category === NEW_CATEGORY ? newName.trim() : null, baselineChannelIds: settings.baselineChannelIds });
      setSaved(true);
    } catch (cause) {
      setError(isConflict(cause) ? 'The settings changed in another tab. The latest are shown; make your edit again.'
        : describeError(cause, 'The settings could not be saved.'));
    }
  };

  return <section aria-label="Room settings" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold text-fg">Room settings</h3>
      <p className="text-xs text-fg-muted">The bot keeps one voice room per table. Table 3 serves match M3 in every round and every event.</p>
    </header>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Field label="Room name template" error={templateError}
          description={`Tokens: ${MATCH_ROOM_TEMPLATE_TOKENS.map(token => `{${token}}`).join(' ')}. Up to ${MATCH_ROOM_LIMITS.nameLength} characters.`}>
          <Input value={template} maxLength={MATCH_ROOM_LIMITS.nameLength} spellCheck={false} disabled={!canEdit}
            onChange={event => edit(() => setTemplate(event.target.value))} />
        </Field>
        <div role="group" aria-label="Template presets" className="flex flex-wrap gap-1.5">
          {MATCH_ROOM_TEMPLATE_PRESETS.map(preset => <Button key={preset} size="sm" variant={template === preset ? 'secondary' : 'ghost'}
            disabled={!canEdit} aria-pressed={template === preset} aria-label={`Use preset ${preset}`}
            onClick={() => edit(() => setTemplate(preset))}>{preset}</Button>)}
        </div>
        <section aria-label="Name preview" className="rounded-md bg-sunken p-2">
          <h4 className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">Preview</h4>
          {templateError ? <p className="text-xs text-fg-subtle">Fix the template to see the names.</p>
            : <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-fg">
              {PREVIEW_TABLES.map(table => <li key={table}>{renderMatchRoomName(template, { matchId: `M${table}` as MatchId, table,
                round: data.round || 1, eventName: data.eventName, gameLabel: data.gameLabel })}</li>)}
            </ul>}
        </section>
        {renamesRooms && !templateError && <p className="text-xs text-fg-muted">Saving renames the rooms right away. {MATCH_ROOM_RENAME_NOTICE}</p>}
      </div>
      <div className="flex flex-col gap-2">
        <Field label="Put match rooms in" description="Tables 1–50 go in this category. More tables use categories the bot creates, such as “One Piece 51–100”.">
          <Select value={category} disabled={!canEdit} onChange={event => edit(() => setCategory(event.target.value))}>
            <option value="">No category</option>
            {category !== '' && category !== NEW_CATEGORY && !categories.some(item => item.id === category)
              && <option value={category}>(missing) …{category.slice(-4)}</option>}
            {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value={NEW_CATEGORY}>Create a new category…</option>
          </Select>
        </Field>
        {category === NEW_CATEGORY && <Field label="New category name" error={nameError}>
          <Input value={newName} maxLength={100} disabled={!canEdit} onChange={event => edit(() => setNewName(event.target.value))} />
        </Field>}
        {settings.pendingCategoryName && settings.categoryId === null && <p className="text-xs text-fg-muted">
          “{settings.pendingCategoryName}” is created with the next rooms.</p>}
        {settings.categoryId && <p className="text-xs text-fg-subtle">Current category: {settings.categoryName ?? `…${settings.categoryId.slice(-4)}`}</p>}
      </div>
    </div>
    {canEdit && <footer className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs">
        {error ? <span role="alert" className="text-danger">{error}</span>
          : saved ? <span role="status" className="text-fg-muted">Settings saved.{data.rooms.some(room => room.rename.state !== 'synced') ? ` ${MATCH_ROOM_RENAME_NOTICE}` : ''}</span>
            : <span className="text-fg-subtle">Version {settings.version}{dirty ? ' · unsaved changes' : ''}</span>}
      </span>
      <Button size="sm" variant="ghost" disabled={!dirty || saveSettings.isPending}
        onClick={() => { setTemplate(settings.template); setCategory(savedCategoryOf(settings)); setNewName(savedNameOf(settings)); setError(null); }}>Undo</Button>
      <Button size="sm" variant="primary" loading={saveSettings.isPending} disabled={!dirty || !!templateError || !!nameError}
        onClick={() => { void save(); }}>Save settings</Button>
    </footer>}
  </section>;
}
