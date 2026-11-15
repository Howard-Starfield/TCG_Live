// Shared chrome for a settings section saved through useAdminToolsSection: conflict banner, save bar.
import type { AdminToolsSettingsSection } from '@tcg-live/core';
import type { ReactNode } from 'react';
import { Button } from '../../../ui';
import { describeError } from '../../evidence/api';
import type { AdminToolsSectionEditor } from '../api';

export function SectionFrame<K extends AdminToolsSettingsSection>({ editor, title, description, canEdit, children }: {
  editor: AdminToolsSectionEditor<K>; title: string; description?: ReactNode; canEdit: boolean; children: ReactNode;
}) {
  if (editor.loadError) return <p role="alert" className="text-xs text-danger">{describeError(editor.loadError, 'Settings could not be loaded.')}</p>;
  if (editor.loading || editor.value === undefined) return <p role="status" className="text-xs text-fg-muted">Loading settings…</p>;
  return <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {description && <p className="text-xs text-fg-muted">{description}</p>}
    </header>
    {editor.conflict && <div role="alert" className="flex flex-col gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <span><b>Settings changed elsewhere.</b> The latest saved settings are shown. Your edits were kept aside, not saved.</span>
      <span className="flex gap-2">
        <Button size="sm" variant="primary" onClick={editor.reapply}>Reapply my edits</Button>
        <Button size="sm" variant="ghost" onClick={editor.discardStash}>Discard my edits</Button>
      </span>
    </div>}
    {children}
    {canEdit && <footer className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs">
        {editor.saveError ? <span role="alert" className="text-danger">{editor.saveError}</span>
          : <span className="text-fg-subtle">Version {editor.saved?.version ?? 0}{editor.dirty ? ' · unsaved changes' : ''}</span>}
      </span>
      <Button variant="ghost" size="sm" disabled={!editor.dirty || editor.saving} onClick={editor.reset}>Undo</Button>
      <Button variant="primary" size="sm" loading={editor.saving} disabled={!editor.dirty} onClick={() => { void editor.save(); }}>Save</Button>
    </footer>}
  </section>;
}
