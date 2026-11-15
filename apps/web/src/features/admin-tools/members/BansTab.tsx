// Bans tab: the server's ban list loaded page by page (Discord cursor), filtered in the browser by name,
// ID or reason, with the linked case and Unban (reason required, creates a case).
import { Ban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Avatar, Button, EmptyState, Input } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useBanList, useCanModerate } from './api';
import { ModActionDialog, type ModTarget } from './ModActionDialog';

export function BansTab() {
  const bans = useBanList();
  const canModerate = useCanModerate();
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<ModTarget | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const all = useMemo(() => bans.data?.pages.flatMap(page => page.bans) ?? [], [bans.data]);
  const q = filter.trim().toLowerCase();
  const rows = q ? all.filter(ban => ban.username.toLowerCase().includes(q) || ban.userId.includes(q) || (ban.reason ?? '').toLowerCase().includes(q)) : all;
  if (bans.isPending) return <p role="status" className="text-xs text-fg-muted">Loading bans…</p>;
  if (bans.error) return <p role="alert" className="text-xs text-danger">{describeError(bans.error, 'The ban list could not be loaded.')}</p>;
  return <section aria-label="Ban list" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="Filter bans" placeholder="Filter by name, ID or reason" value={filter} onChange={event => setFilter(event.target.value)}
        className="max-w-xs" />
      <span className="text-xs text-fg-subtle">{all.length} loaded{bans.hasNextPage ? ' (more on Discord)' : ''}</span>
      {bans.hasNextPage && <Button size="sm" variant="ghost" loading={bans.isFetchingNextPage} onClick={() => { void bans.fetchNextPage(); }}>Load more</Button>}
    </div>
    {done && <p role="status" className="text-xs text-fg-muted">{done}</p>}
    {rows.length === 0 ? <EmptyState compact icon={<Ban />} title={all.length ? 'No bans match' : 'Nobody is banned'} />
      : <ul className="flex flex-col divide-y divide-line">
        {rows.map(ban => <li key={ban.userId} className="flex items-center gap-3 py-2">
          <Avatar src={ban.avatarUrl} name={ban.username} size="sm" decorative />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg">{ban.username} <span className="font-mono text-xs text-fg-subtle">{ban.userId}</span></span>
            <span className="block truncate text-xs text-fg-muted">{ban.reason ?? 'No reason given'}
              {ban.caseNumber !== null && <> · Case #{ban.caseNumber}</>}</span>
          </span>
          {canModerate && <Button size="sm" onClick={() => { setDone(null); setTarget({ id: ban.userId, name: ban.username }); }}>Unban</Button>}
        </li>)}
      </ul>}
    <ModActionDialog target={target} action={target ? 'unban' : null} onClose={() => setTarget(null)}
      onDone={result => setDone(`Unbanned. Case #${result.case.number} saved.`)} />
  </section>;
}
