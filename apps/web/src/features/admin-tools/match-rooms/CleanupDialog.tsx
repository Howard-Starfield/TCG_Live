// "Clean up after tournament": previews what the bot would delete, restore, keep and skip, and does it only after Confirm.
// The server hands out a plan token; a plan that changed since the preview is refused (409) and the preview is re-read.
import type { CleanupPlanDto, CleanupPlanItemDto, CleanupResultDto } from '@tcg-live/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAdminData } from '../../../data';
import { Badge, Button, Dialog } from '../../../ui';
import { describeError } from '../../evidence/api';
import { MATCH_ROOM_RENAME_NOTICE } from '@tcg-live/core';
import { confirmCleanup, getCleanupPlan, isConflict, matchRoomsKeys, REVIEW_AGAIN } from './api';

const GROUPS: ReadonlyArray<{ action: CleanupPlanItemDto['action']; title: string; note: string }> = [
  { action: 'delete', title: 'Will be deleted', note: 'Rooms and categories the bot created.' },
  { action: 'restore', title: 'Will be restored', note: 'Channels the bot adopted get their original name and permissions back.' },
  { action: 'keep', title: 'Kept', note: '' },
  { action: 'skip', title: 'Skipped', note: 'Left alone for now.' }];

const itemName = (item: CleanupPlanItemDto) => item.name ?? `Channel …${item.channelId.slice(-4)}`;

function Group({ title, note, items }: { title: string; note: string; items: CleanupPlanItemDto[] }) {
  if (items.length === 0) return null;
  return <section aria-label={title} className="flex flex-col gap-1">
    <h3 className="text-[13px] font-semibold text-fg">{title} <span className="font-normal text-fg-subtle">({items.length})</span></h3>
    {note && <p className="text-xs text-fg-subtle">{note}</p>}
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
      {items.map(item => <li key={item.channelId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-xs">
        <Badge>{item.kind === 'room' ? 'Room' : 'Category'}</Badge>
        <b className="font-medium text-fg">{itemName(item)}</b>
        {item.action === 'restore' && item.restoreName && <span className="text-fg-muted">back to “{item.restoreName}”</span>}
        <span className="text-fg-muted">{item.reason}</span>
      </li>)}
    </ul>
  </section>;
}

function Result({ result, plan }: { result: CleanupResultDto; plan: CleanupPlanDto | null }) {
  const nameOf = (channelId: string) => plan?.items.find(item => item.channelId === channelId)?.name ?? `…${channelId.slice(-4)}`;
  return <section aria-label="Clean-up result" className="flex flex-col gap-2">
    <p role="status" className="text-sm font-medium text-fg">Clean-up finished.</p>
    <ul className="list-disc pl-5 text-sm text-fg-muted">
      <li>{result.deleted.length} deleted</li>
      <li>{result.restored.length} restored</li>
      <li>{result.archived} room {result.archived === 1 ? 'chat' : 'chats'} archived</li>
      <li>{result.skipped.length} skipped</li>
    </ul>
    {result.skipped.length > 0 && <ul aria-label="Skipped channels" className="flex flex-col gap-1 text-xs text-fg-muted">
      {result.skipped.map(item => <li key={item.channelId}><b className="font-medium text-fg">{nameOf(item.channelId)}</b> {item.reason}</li>)}
    </ul>}
    {result.restored.length > 0 && <p className="text-xs text-fg-muted">{MATCH_ROOM_RENAME_NOTICE}</p>}
  </section>;
}

export function CleanupDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { api } = useAdminData();
  const client = useQueryClient();
  const [plan, setPlan] = useState<CleanupPlanDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<CleanupResultDto | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true); setError(null);
    try {
      const next = await getCleanupPlan(api, controller.signal);
      if (!controller.signal.aborted) setPlan(next);
    } catch (cause) {
      if (!controller.signal.aborted) { setPlan(null); setError(describeError(cause, 'The clean-up preview could not be loaded.')); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    setPlan(null); setResult(null); setStale(false); setError(null);
    void load();
    return () => { abort.current?.abort(); };
  }, [open, load]);

  const confirm = async () => {
    if (!plan || busy) return;
    setBusy(true); setError(null); setStale(false);
    try {
      setResult(await confirmCleanup(api, plan.planToken));
      void client.invalidateQueries({ queryKey: matchRoomsKeys.all() });
    } catch (cause) {
      if (isConflict(cause)) { setStale(true); await load(); }
      else setError(describeError(cause, 'The clean-up could not be completed.'));
    } finally { setBusy(false); }
  };

  const changes = plan ? plan.items.filter(item => item.action === 'delete' || item.action === 'restore').length : 0;
  const done = result !== null;
  return <Dialog open={open} onClose={onClose} width="lg" dismissible={!busy} tone={done ? 'default' : 'danger'}
    title={done ? 'Clean-up finished' : 'Clean up after tournament'}
    description={done ? undefined : 'Review what the bot will do. Nothing changes until you press Confirm.'}
    footer={done ? <Button size="sm" variant="primary" onClick={onClose}>Close</Button> : <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="danger" loading={busy} disabled={!plan || loading || changes === 0} onClick={() => { void confirm(); }}>Confirm clean-up</Button>
    </>}>
    {done ? <Result result={result} plan={plan} /> : <div className="flex flex-col gap-3">
      {stale && <p role="alert" className="rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">{REVIEW_AGAIN}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}{' '}<Button size="sm" variant="ghost" onClick={() => { void load(); }}>Try again</Button></p>}
      {loading && !plan && <p role="status" className="text-xs text-fg-muted">Checking the rooms…</p>}
      {plan && <>
        {plan.transcriptsToArchive > 0 && <p className="text-xs text-fg">
          {plan.transcriptsToArchive} room {plan.transcriptsToArchive === 1 ? 'chat' : 'chats'} will be archived first.</p>}
        {changes === 0 && <p className="text-xs text-fg-muted">Nothing to delete or restore.</p>}
        {GROUPS.map(group => <Group key={group.action} title={group.title} note={group.note} items={plan.items.filter(item => item.action === group.action)} />)}
      </>}
    </div>}
  </Dialog>;
}
