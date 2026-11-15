// Confirm dialog for warn / timeout / remove timeout / kick / ban / unban: reason required, timeout length
// (Discord caps at 28 days), ban message-deletion window. Errors from the server (role hierarchy, missing
// permission) are shown inside the dialog.
import type { ModAction, ModActionRequestDto, ModActionResultDto } from '@tcg-live/core';
import { useEffect, useState } from 'react';
import { ConfirmDialog, Field, Select } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useModAction } from './api';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const TIMEOUT_PRESETS = [
  { label: '1 minute', ms: MIN }, { label: '10 minutes', ms: 10 * MIN }, { label: '1 hour', ms: HOUR }, { label: '1 day', ms: DAY },
  { label: '1 week', ms: 7 * DAY }, { label: '28 days (Discord maximum)', ms: 28 * DAY }
] as const;
export const DELETE_WINDOWS = [
  { label: "Don't delete any", seconds: 0 }, { label: 'Previous hour', seconds: 3600 }, { label: 'Previous 24 hours', seconds: 86_400 },
  { label: 'Previous 3 days', seconds: 3 * 86_400 }, { label: 'Previous 7 days', seconds: 604_800 }
] as const;

export const ACTION_LABEL: Record<ModAction, string> = {
  warn: 'Warn', timeout: 'Timeout', untimeout: 'Remove timeout', kick: 'Kick', ban: 'Ban', unban: 'Unban'
};
const DESTRUCTIVE: readonly ModAction[] = ['timeout', 'kick', 'ban'];

/** What happens, in one sentence, for the confirm step (the title names the member). */
export const ACTION_CONSEQUENCE: Record<ModAction, string> = {
  warn: 'A warning case is recorded; nothing changes in Discord.',
  timeout: 'The member cannot send messages, react or join voice until the timeout ends.',
  untimeout: 'The member can talk again right away.',
  kick: 'The member is messaged first (when DMs are on), then removed from the server. They can rejoin with an invite.',
  ban: 'The member is messaged first (when DMs are on), then banned: removed and unable to rejoin until unbanned.',
  unban: 'The user may rejoin the server with an invite.'
};

export interface ModTarget { id: string; name: string }
export interface ModContext { eventId?: string | null; matchId?: ModActionRequestDto['matchId'] }

export function ModActionDialog({ target, action, context, onClose, onDone }: {
  target: ModTarget | null; action: ModAction | null; context?: ModContext; onClose(): void; onDone?(result: ModActionResultDto): void;
}) {
  const mutation = useModAction();
  const [durationMs, setDurationMs] = useState<number>(HOUR);
  const [deleteSeconds, setDeleteSeconds] = useState<number>(0);
  const open = !!target && !!action;
  useEffect(() => { if (open) { mutation.reset(); setDurationMs(HOUR); setDeleteSeconds(0); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target || !action) return <ConfirmDialog open={false} onCancel={onClose} onConfirm={() => {}} title="" />;
  const confirm = (reason: string) => {
    const base = { userId: target.id, reason, ...(context?.eventId ? { eventId: context.eventId } : {}), ...(context?.matchId ? { matchId: context.matchId } : {}) };
    const body: ModActionRequestDto = action === 'timeout' ? { ...base, action, durationMs }
      : action === 'ban' ? { ...base, action, deleteMessageSeconds: deleteSeconds, durationMs: null } : { ...base, action };
    mutation.mutate(body, { onSuccess: result => { onDone?.(result); onClose(); } });
  };
  return <ConfirmDialog open={open} onCancel={onClose} onConfirm={confirm} requireReason pending={mutation.isPending}
    danger={DESTRUCTIVE.includes(action)} confirmLabel={ACTION_LABEL[action]} title={`${ACTION_LABEL[action]} ${target.name}?`}
    reasonDescription="Saved in a numbered case and the server's audit log. Shown to the member when DMs are on."
    description={ACTION_CONSEQUENCE[action]}>
    {action === 'timeout' && <Field label="Length">
      <Select value={String(durationMs)} onChange={event => setDurationMs(Number(event.target.value))}>
        {TIMEOUT_PRESETS.map(preset => <option key={preset.ms} value={preset.ms}>{preset.label}</option>)}
      </Select>
    </Field>}
    {action === 'ban' && <Field label="Delete their recent messages">
      <Select value={String(deleteSeconds)} onChange={event => setDeleteSeconds(Number(event.target.value))}>
        {DELETE_WINDOWS.map(window => <option key={window.seconds} value={window.seconds}>{window.label}</option>)}
      </Select>
    </Field>}
    {mutation.error && <p role="alert" className="text-xs text-danger">{describeError(mutation.error, 'The action failed.')}</p>}
  </ConfirmDialog>;
}
