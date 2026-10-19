// Discord panels tab (read-only): channels, card slots and the runtime's card and room state.
import type { CardSlot, EventSnapshotDto, MatchId, RuntimeStatusDto, Snowflake } from '@tcg-live/core';
import { AlertTriangle } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useRuntimeStatus } from '../../data';
import { DataTable, type Column } from '../../ui';
import { IdValue, None, StatusChip } from './shared';

const SLOT_LABEL: Record<CardSlot, string> = { checkin: 'Check-in', M1: 'Match M1', M2: 'Match M2' };
const SLOTS: CardSlot[] = ['checkin', 'M1', 'M2'];

interface CardRow { slot: CardSlot; messageId: Snowflake | null; repostSuspended: boolean }

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-0.5">
        <h3 id={id} className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <dl className="lists-dl grid grid-cols-[minmax(6.5rem,max-content)_minmax(0,1fr)] overflow-hidden rounded-lg bg-raised text-xs shadow-[inset_0_0_0_1px_var(--color-line)]">
      {children}
    </dl>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-8 items-center border-b border-line-faint px-2.5 text-fg-muted">{label}</dt>
      <dd className="m-0 flex min-h-8 min-w-0 items-center border-b border-line-faint px-2.5 text-fg">{children}</dd>
    </>
  );
}

function cardStatus(row: CardRow) {
  if (row.repostSuspended) return { label: 'Repost suspended', tone: 'warning' as const };
  if (row.messageId) return { label: 'Posted', tone: 'success' as const };
  return { label: 'Not posted', tone: 'neutral' as const };
}

const cardColumns: Array<Column<CardRow>> = [
  { id: 'slot', header: 'Card', sortValue: row => SLOTS.indexOf(row.slot), cell: row => <span className="font-medium">{SLOT_LABEL[row.slot]}</span> },
  { id: 'message', header: 'Message ID', sortValue: row => row.messageId,
    cell: row => (row.messageId ? <IdValue value={row.messageId} what={`${SLOT_LABEL[row.slot]} card message`} /> : <None label="Not posted" />) },
  { id: 'state', header: 'State', cell: row => <StatusChip meta={cardStatus(row)} /> }
];

function RuntimeRows({ query }: { query: { data: RuntimeStatusDto | undefined; isPending: boolean; error: Error | null } }) {
  const status = query.data;
  if (!status) {
    return (
      <Rows>
        <Row label="Runtime">
          <span className="text-fg-subtle" role={query.error ? 'alert' : 'status'}>
            {query.error ? 'Runtime status unavailable' : 'Checking runtime…'}
          </span>
        </Row>
      </Rows>
    );
  }
  return (
    <Rows>
      <Row label="Cards">
        <StatusChip meta={status.cards.updatePending
          ? { label: 'Update pending', tone: 'warning', live: true } : { label: 'In sync', tone: 'success' }} />
      </Row>
      <Row label="Match rooms">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
          <StatusChip meta={status.rooms.enabled ? { label: 'Managed', tone: 'success' } : { label: 'Off', tone: 'neutral' }} />
          {status.rooms.warning && (
            <span role="note" className="inline-flex min-w-0 items-start gap-1 text-warning">
              <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{status.rooms.warning}</span>
            </span>
          )}
        </span>
      </Row>
    </Rows>
  );
}

export function PanelsTab({ snapshot }: { snapshot: EventSnapshotDto }) {
  const runtime = useRuntimeStatus();
  const { discord } = snapshot;
  const cards: CardRow[] = SLOTS.map(slot => ({ slot, ...discord.cards[slot] }));
  return (
    <div className="lists-panels flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-1">
      <Section title="Channels">
        <Rows>
          <Row label="Guild"><IdValue value={discord.guildId} what="guild" /></Row>
          <Row label="Channel"><IdValue value={discord.channelId} what="channel" /></Row>
          {(['M1', 'M2'] as MatchId[]).map(matchId => (
            <Row key={matchId} label={`${matchId} room`}>
              {discord.matchChannels
                ? <IdValue value={discord.matchChannels[matchId]} what={`${matchId} room channel`} />
                : <span className="text-fg-subtle">Not created</span>}
            </Row>
          ))}
          <Row label="Public rooms">
            <StatusChip meta={discord.publicMatchRooms ? { label: 'Public', tone: 'accent' } : { label: 'Private', tone: 'neutral' }} />
          </Row>
          <Row label="Panel revision">
            <span className="font-mono tabular-nums" title="Process-local; increments whenever the bot changes a card or panel">{snapshot.panelRevision}</span>
          </Row>
        </Rows>
      </Section>
      <Section title="Cards">
        <DataTable<CardRow> label="Discord cards" dense className="lists-table shrink-0" columns={cardColumns} rows={cards}
          getRowId={row => row.slot} />
      </Section>
      <Section title="Runtime">
        <RuntimeRows query={runtime} />
      </Section>
      <p className="px-0.5 text-2xs text-fg-subtle">Read-only. Message IDs change when the bot reposts a card.</p>
    </div>
  );
}
