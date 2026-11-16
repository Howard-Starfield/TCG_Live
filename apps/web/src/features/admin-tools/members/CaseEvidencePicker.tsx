// Evidence picker for a case from a match: the match's evidence as checkboxes (up to 10 attached), instead
// of typing raw IDs. IDs from other matches that are already attached stay attached and are listed too.
import type { EvidenceItemDto, MatchId } from '@tcg-live/core';
import { formatTimeOfDay } from '../../../data';
import { Badge } from '../../../ui';
import { describeError, formatBytes, formatDuration, useEvidenceAccess, useEvidenceList } from '../../evidence/api';
import { CASE_EVIDENCE_MAX } from './AttachToCase';

export function evidenceLabel(item: EvidenceItemDto): string {
  const what = item.kind === 'link' ? item.externalUrl ?? 'Link'
    : item.kind === 'note' ? (item.note.length > 60 ? `${item.note.slice(0, 60)}…` : item.note) || 'Text note'
    : item.originalName ?? `${item.kind} file`;
  const facts = [formatBytes(item.byteSize), formatDuration(item.durationMs)].filter(Boolean).join(' · ');
  // A note's text is already the label; don't repeat it.
  return [what, facts, item.kind === 'note' ? '' : item.note].filter(Boolean).join(' · ');
}

/** Toggles `id` in `value`, refusing to go past the case limit. */
export function toggleEvidence(value: readonly string[], id: string): string[] {
  if (value.includes(id)) return value.filter(item => item !== id);
  return value.length >= CASE_EVIDENCE_MAX ? [...value] : [...value, id];
}

export function CaseEvidencePicker({ eventId, matchId, value, onChange, disabled }: {
  eventId: string; matchId: MatchId; value: readonly string[]; onChange(ids: string[]): void; disabled?: boolean;
}) {
  const access = useEvidenceAccess();
  const list = useEvidenceList(eventId, matchId, access.read);
  if (!access.read) return null;
  const items = (list.data?.items ?? []).filter(item => item.status !== 'deleted' || value.includes(item.id));
  const others = value.filter(id => !items.some(item => item.id === id));
  return <fieldset className="flex flex-col gap-1.5" aria-label={`Evidence from ${matchId}`}>
    <legend className="text-xs font-medium text-fg">Evidence from {matchId} <span className="text-fg-subtle">({value.length} of {CASE_EVIDENCE_MAX})</span></legend>
    {list.isLoading ? <p role="status" className="text-xs text-fg-muted">Loading evidence…</p>
      : list.error && !list.data ? <p role="alert" className="text-xs text-danger">{describeError(list.error, 'Evidence could not be loaded.')}</p>
      : items.length === 0 ? <p className="text-xs text-fg-muted">This match has no evidence.</p>
      : <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {items.map(item => {
          const checked = value.includes(item.id);
          return <li key={item.id}>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={checked} disabled={disabled || (!checked && value.length >= CASE_EVIDENCE_MAX)}
                onChange={() => onChange(toggleEvidence(value, item.id))} className="mt-0.5" />
              <Badge tone="neutral">{item.kind}</Badge>
              <span className="min-w-0 flex-1 truncate text-fg" title={item.id}>{evidenceLabel(item)}</span>
              <span className="font-mono text-2xs text-fg-subtle">{formatTimeOfDay(item.createdAtMs)}</span>
            </label>
          </li>;
        })}
      </ul>}
    {others.length > 0 && <p className="text-2xs text-fg-subtle">Also attached from elsewhere: <span className="font-mono">{others.join(', ')}</span></p>}
  </fieldset>;
}
