// "Moderate" row menu for tournament views (Players tab): warn, timeout, kick or ban a player with the
// tournament (and match) attached to the case. Renders nothing without admin tools or members.moderate.
import type { MatchId, ModAction } from '@tcg-live/core';
import { Gavel } from 'lucide-react';
import { useState } from 'react';
import { IconButton, Menu } from '../../../ui';
import { useCanModerate } from './api';
import { ACTION_LABEL, ModActionDialog } from './ModActionDialog';

const MENU_ACTIONS: readonly ModAction[] = ['warn', 'timeout', 'kick', 'ban'];

export { useCanModerate as useModerateAvailable };

export function ModerateMemberAction({ memberId, name, eventId, matchId = null }: {
  memberId: string | null; name: string; eventId: string; matchId?: MatchId | null;
}) {
  const canModerate = useCanModerate();
  const [action, setAction] = useState<ModAction | null>(null);
  if (!canModerate || !memberId) return null;
  return <>
    <Menu label={`Moderate ${name}`} placement="bottom-end"
      items={MENU_ACTIONS.map(item => ({ id: item, label: ACTION_LABEL[item], danger: item === 'kick' || item === 'ban', onSelect: () => setAction(item) }))}
      trigger={props => <IconButton {...props} size="sm" aria-label={`Moderate ${name}`} icon={<Gavel aria-hidden />} />} />
    <ModActionDialog target={action ? { id: memberId, name } : null} action={action} context={{ eventId, matchId }} onClose={() => setAction(null)} />
  </>;
}
