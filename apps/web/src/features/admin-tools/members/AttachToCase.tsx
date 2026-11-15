// "Attach to case…" for one evidence item: pick an existing case of one of the match's members (the
// evidence ID is appended, up to 10 per case) or open a new case (warn / timeout / kick / ban) with the
// evidence, tournament and match already attached. Renders nothing without members.moderate.
import type { MatchId, ModAction, ModCaseDto } from '@tcg-live/core';
import { Paperclip } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Dialog, Field, Select } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useCanModerate, useCases, useUpdateCase } from './api';
import { ACTION_LABEL, ModActionDialog } from './ModActionDialog';
import { formatDateTime } from './MembersTab';

export const CASE_EVIDENCE_MAX = 10;

/** The case's evidence IDs with `evidenceId` added once; null when the case is already full. */
export function withEvidence(item: Pick<ModCaseDto, 'evidenceIds'>, evidenceId: string): string[] | null {
  if (item.evidenceIds.includes(evidenceId)) return item.evidenceIds;
  if (item.evidenceIds.length >= CASE_EVIDENCE_MAX) return null;
  return [...item.evidenceIds, evidenceId];
}

export interface AttachToCaseProps {
  evidenceId: string;
  members: ReadonlyArray<{ id: string | null; name: string }>;
  eventId: string;
  matchId: MatchId;
}

function CaseRows({ memberId, evidenceId, onDone }: { memberId: string; evidenceId: string; onDone(message: string): void }) {
  const cases = useCases({ targetId: memberId, kind: '', moderatorId: '' });
  const update = useUpdateCase();
  const rows = cases.data?.pages.flatMap(page => page.cases) ?? [];
  if (cases.isPending) return <p role="status" className="text-xs text-fg-muted">Loading cases…</p>;
  if (cases.error) return <p role="alert" className="text-xs text-danger">{describeError(cases.error, 'Cases could not be loaded.')}</p>;
  if (!rows.length) return <p className="text-xs text-fg-muted">This member has no cases yet. Open a new one below.</p>;
  return <>
    <ul aria-label="Existing cases" className="flex max-h-64 flex-col divide-y divide-line overflow-y-auto">
      {rows.map(item => {
        const next = withEvidence(item, evidenceId);
        const attached = item.evidenceIds.includes(evidenceId);
        return <li key={item.number} className="flex items-center gap-2 py-1.5 text-xs">
          <span className="w-10 font-mono text-fg-subtle">#{item.number}</span><Badge tone="neutral">{item.kind}</Badge>
          <span className="min-w-0 flex-1 truncate text-fg" title={item.reason}>{item.reason}</span>
          <span className="text-fg-subtle">{formatDateTime(item.createdAtMs)}</span>
          <Button size="sm" variant="secondary" disabled={attached || !next || update.isPending}
            title={!next ? `A case holds up to ${CASE_EVIDENCE_MAX} evidence items.` : undefined}
            onClick={() => next && update.mutate({ number: item.number, evidenceIds: next }, { onSuccess: () => onDone(`Attached to case #${item.number}.`) })}>
            {attached ? 'Attached' : 'Attach'}</Button>
        </li>;
      })}
    </ul>
    {update.error && <p role="alert" className="text-xs text-danger">{describeError(update.error, 'The case could not be saved.')}</p>}
  </>;
}

export function AttachToCaseButton({ evidenceId, members, eventId, matchId }: AttachToCaseProps) {
  const canModerate = useCanModerate();
  const targets = members.filter((member): member is { id: string; name: string } => !!member.id)
    .filter((member, index, list) => list.findIndex(other => other.id === member.id) === index);
  const [open, setOpen] = useState(false);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [action, setAction] = useState<ModAction>('warn');
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!canModerate || !targets.length) return null;
  const chosen = targets.find(member => member.id === memberId) ?? targets[0]!;
  return <>
    <Button size="sm" variant="ghost" icon={<Paperclip aria-hidden />} onClick={() => { setNote(null); setOpen(true); }}>Attach to case…</Button>
    <Dialog open={open && !creating} onClose={() => setOpen(false)} title="Attach evidence to a case" width="lg"
      description={`Evidence ${evidenceId} · ${matchId}`}
      footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      <div className="flex flex-col gap-3">
        <Field label="Member">
          <Select value={chosen.id} onChange={event => setMemberId(event.target.value)}>
            {targets.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
          </Select>
        </Field>
        {note && <p role="status" className="text-xs text-success">{note}</p>}
        <CaseRows key={chosen.id} memberId={chosen.id} evidenceId={evidenceId} onDone={setNote} />
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Or open a new case">
            <Select aria-label="New case action" value={action} onChange={event => setAction(event.target.value as ModAction)}>
              {(['warn', 'timeout', 'kick', 'ban'] as const).map(item => <option key={item} value={item}>{ACTION_LABEL[item]}</option>)}
            </Select>
          </Field>
          <Button variant="secondary" onClick={() => setCreating(true)}>New case…</Button>
        </div>
      </div>
    </Dialog>
    <ModActionDialog target={creating ? chosen : null} action={creating ? action : null}
      context={{ eventId, matchId, evidenceIds: [evidenceId] }}
      onClose={() => setCreating(false)} onDone={result => setNote(`Case #${result.case.number} opened with this evidence.`)} />
  </>;
}
