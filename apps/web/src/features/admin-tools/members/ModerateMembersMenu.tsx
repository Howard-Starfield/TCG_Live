// "Moderate member" for places that concern one or more members (a match's two players, a flagged member,
// an evidence item): a menu of warn / timeout / kick / ban per member, opening the shared ModActionDialog
// with the tournament, match and evidence attached to the case. Renders nothing without members.moderate.
import type { MatchId, ModAction } from '@tcg-live/core';
import { Gavel } from 'lucide-react';
import { useState } from 'react';
import { Button, IconButton, Menu, type MenuEntry } from '../../../ui';
import { useCanModerate } from './api';
import { ACTION_LABEL, ModActionDialog, type ModTarget } from './ModActionDialog';

const ACTIONS: readonly ModAction[] = ['warn', 'timeout', 'kick', 'ban'];

export interface ModerateMembersMenuProps {
  /** Members that can be moderated here; entries without an ID are skipped. */
  members: ReadonlyArray<{ id: string | null; name: string }>;
  eventId?: string | null;
  matchId?: MatchId | null;
  evidenceIds?: string[];
  /** Accessible name of the trigger. */
  label?: string;
  /** 'icon' for table rows, 'button' for cards and headers. */
  variant?: 'icon' | 'button';
}

/** Menu entries: per member a label and its actions (a single member gets the actions only). */
export function moderationMenuEntries(members: ReadonlyArray<ModTarget>, choose: (target: ModTarget, action: ModAction) => void): MenuEntry[] {
  return members.flatMap((member, index) => [
    ...(members.length > 1 ? [
      ...(index > 0 ? [{ type: 'separator' as const, id: `sep-${member.id}` }] : []),
      { type: 'label' as const, id: `label-${member.id}`, label: member.name }] : []),
    ...ACTIONS.map(action => ({ id: `${member.id}-${action}`, label: members.length > 1 ? `${ACTION_LABEL[action]} ${member.name}` : ACTION_LABEL[action],
      textValue: `${ACTION_LABEL[action]} ${member.name}`, danger: action === 'kick' || action === 'ban', onSelect: () => choose(member, action) }))
  ]);
}

export function ModerateMembersMenu({ members, eventId = null, matchId = null, evidenceIds, label, variant = 'icon' }: ModerateMembersMenuProps) {
  const canModerate = useCanModerate();
  const [pending, setPending] = useState<{ target: ModTarget; action: ModAction } | null>(null);
  const targets = members.filter((member): member is ModTarget => !!member.id)
    .filter((member, index, list) => list.findIndex(other => other.id === member.id) === index);
  if (!canModerate || targets.length === 0) return null;
  const name = label ?? (targets.length === 1 ? `Moderate ${targets[0]!.name}` : 'Moderate a member');
  // Keep clicks and keys inside the menu and dialog away from table rows (React events bubble through portals).
  return <span className="contents" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Menu label={name} placement="bottom-end" items={moderationMenuEntries(targets, (target, action) => setPending({ target, action }))}
      trigger={props => variant === 'icon'
        ? <IconButton {...props} size="sm" aria-label={name} icon={<Gavel aria-hidden />} />
        : <Button {...props} size="sm" variant="secondary" icon={<Gavel aria-hidden />} aria-label={name}>Moderate</Button>} />
    <ModActionDialog target={pending?.target ?? null} action={pending?.action ?? null}
      context={{ eventId, matchId, ...(evidenceIds?.length ? { evidenceIds } : {}) }} onClose={() => setPending(null)} />
  </span>;
}
