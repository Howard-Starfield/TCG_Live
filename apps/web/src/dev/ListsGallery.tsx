// Owned by L7 (web-lists): the List preview for every fixture and tab, light and dark, plus audit
// paging, loading, error and empty states and a narrow pane. Data hooks run against a fake API.
// Filters: `#/__lists?fixture=final` (or `none`), `&tab=audit`, `&extras=0` (hide the state specimens).
import type { AuditEntryDto, EventSnapshotDto, MatchId } from '@tcg-live/core';
import { auditTimeline, FIXTURE_ADMIN_ID, FIXTURE_NOW_MS, snapshots, type SnapshotFixtureName } from '@tcg-live/core/fixtures';
import { useState } from 'react';
import { ListPreview, LIST_TABS, type ListTab } from '../features/lists';
import { FixtureDataProvider, syntheticAudit, type FixtureDataOptions } from '../features/lists/fixtureData';
import { GalleryFrame } from './GalleryFrame';

const FIXTURE_NAMES = Object.keys(snapshots) as SnapshotFixtureName[];
const TAB_VALUES = LIST_TABS.map(tab => tab.value);

/** The final fixture's extra applied commands after the liveDispute timeline (versions 18–20). */
const finalTail: AuditEntryDto[] = [
  { sequence: 18, commandId: 'interaction:1300000000000000018', occurredAtMs: FIXTURE_NOW_MS + 60_000,
    actor: { kind: 'player', seat: 'A' }, via: 'discord', principalId: '900000000000000011',
    command: { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }, result: 'propose', mode: 'CAM' },
  { sequence: 19, commandId: 'interaction:1300000000000000019', occurredAtMs: FIXTURE_NOW_MS + 75_000,
    actor: { kind: 'player', seat: 'B' }, via: 'discord', principalId: '900000000000000012',
    command: { type: 'confirm', matchId: 'M1', revision: 1 }, result: 'confirm', mode: 'CAM' },
  { sequence: 20, commandId: 'web:00000000-0000-4000-8000-000000000020', occurredAtMs: FIXTURE_NOW_MS + 140_000,
    actor: { kind: 'admin' }, via: 'web', principalId: 'local-admin',
    command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling after review' }, result: 'resolve', mode: 'CAM' }
];

function auditFor(name: SnapshotFixtureName): AuditEntryDto[] {
  switch (name) {
    case 'signupOpen': return auditTimeline.slice(0, 3);
    case 'checkin': return auditTimeline.slice(0, 8);
    case 'final': return [...auditTimeline, ...finalTail];
    default: return auditTimeline;
  }
}

const retired: EventSnapshotDto = { ...snapshots.final, status: 'retired', retiredAtMs: FIXTURE_NOW_MS + 600_000 };
const emptyRoster: EventSnapshotDto = { ...snapshots.signupOpen, signup: { status: 'open', capacity: 4, roster: [] },
  members: { [FIXTURE_ADMIN_ID]: snapshots.signupOpen.members[FIXTURE_ADMIN_ID]! } };
const noRooms: EventSnapshotDto = { ...snapshots.checkin, discord: { ...snapshots.checkin.discord, matchChannels: null,
  publicMatchRooms: true, cards: { ...snapshots.checkin.discord.cards, checkin: { messageId: '900000000000000201', repostSuspended: true } } } };

function readFilter(): { fixtures: SnapshotFixtureName[]; tabs: ListTab[]; extras: boolean } {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const fixture = query.get('fixture');
  const tab = query.get('tab');
  return {
    fixtures: fixture === 'none' ? [] : fixture && fixture in snapshots ? [fixture as SnapshotFixtureName] : FIXTURE_NAMES,
    tabs: tab && (TAB_VALUES as string[]).includes(tab) ? [tab as ListTab] : TAB_VALUES,
    extras: query.get('extras') !== '0'
  };
}

function Specimen({ title, note, snapshot, initialTab, data, width, height = 300 }: {
  title: string; note?: string; snapshot: EventSnapshotDto; initialTab: ListTab;
  data: Omit<FixtureDataOptions, 'snapshot'>; width?: number; height?: number;
}) {
  const [tab, setTab] = useState<ListTab>(initialTab);
  const [opened, setOpened] = useState<MatchId | null>(null);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex items-baseline gap-2 text-xs text-fg-muted">
        <span className="font-semibold text-fg">{title}</span>
        {note && <span>{note}</span>}
        {opened && <span className="ml-auto">onOpenMatch → {opened}</span>}
      </figcaption>
      <div className="overflow-hidden rounded-xl bg-base pt-2 shadow-hairline" style={{ height, width }}>
        <FixtureDataProvider snapshot={snapshot} {...data}>
          <ListPreview snapshot={snapshot} tab={tab} onTabChange={setTab} onOpenMatch={setOpened} />
        </FixtureDataProvider>
      </div>
    </figure>
  );
}

export function ListsGallery() {
  const { fixtures, tabs, extras } = readFilter();
  const many = syntheticAudit(auditTimeline, 700);
  return (
    <GalleryFrame title="List preview">
      {() => (
        <div className="flex flex-col gap-6">
          {fixtures.flatMap(name => tabs.map(tab => {
            const audit = auditFor(name);
            return (
              <Specimen key={`${name}-${tab}`} title={`${name} · ${tab}`} snapshot={snapshots[name]} initialTab={tab}
                height={tab === 'panels' ? 600 : tab === 'audit' ? 380 : 280} data={{ audit, liveTail: audit.length }} />
            );
          }))}
          {extras && (
            <>
              <Specimen title="narrow pane · matches" note="380 px, horizontal scroll" snapshot={snapshots.liveDispute}
                initialTab="matches" width={380} height={220} data={{ audit: auditTimeline, liveTail: 17 }} />
              <Specimen title="narrow pane · audit" note="380 px" snapshot={snapshots.liveDispute} initialTab="audit"
                width={380} height={330} data={{ audit: auditTimeline, liveTail: 17 }} />
              <Specimen title="audit · live, older entries" note="700 applied, stream tail of 40 → Load older"
                snapshot={snapshots.liveDispute} initialTab="audit" height={320} data={{ audit: many, liveTail: 40 }} />
              <Specimen title="audit · retired event" note="HTTP pages of 500 → Load newer" snapshot={retired}
                initialTab="audit" height={320} data={{ audit: many.slice(0, 520) }} />
              <Specimen title="audit · loading" snapshot={snapshots.liveDispute} initialTab="audit" height={200}
                data={{ auditMode: 'pending' }} />
              <Specimen title="audit · error" snapshot={snapshots.liveDispute} initialTab="audit" height={200}
                data={{ auditMode: 'error' }} />
              <Specimen title="audit · empty" snapshot={emptyRoster} initialTab="audit" height={240}
                data={{ audit: [], liveTail: 0 }} />
              <Specimen title="players · empty roster" snapshot={emptyRoster} initialTab="players" height={240}
                data={{ audit: [] }} />
              <Specimen title="panels · pending cards, room warning, no rooms" snapshot={noRooms} initialTab="panels" height={600}
                data={{ audit: [], status: { cards: { updatePending: true },
                  rooms: { enabled: true, warning: 'Missing Manage Channels permission in TCG Match 2' } } }} />
              <Specimen title="panels · runtime status loading" snapshot={snapshots.signupOpen} initialTab="panels" height={600}
                data={{ audit: [], statusMode: 'pending' }} />
            </>
          )}
        </div>
      )}
    </GalleryFrame>
  );
}
