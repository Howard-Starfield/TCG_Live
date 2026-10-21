import type { AuditEntryDto, EventSnapshotDto, EventSummaryDto, RuntimeStatusDto, SessionDto } from '@tcg-live/core';
import { auditTimeline, final, FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createAdminData, type AdminData } from './admin-data';
import { applyStreamAudit, type AuditLog } from './audit-log';
import { adminKeys, applyStreamEvent, createAdminQueryClient, INACTIVE_EVENT_GC_MS, isSnapshotNewer } from './cache';
import { ServerClock } from './clock';
import { useActiveSnapshot, useAudit, useEvents, useEventSnapshot, useRuntimeStatus, useStreamConnection } from './hooks';
import { AdminDataProvider } from './provider';
import { SESSION_TOKEN_KEY } from './session';
import { createMemoryStorage } from './storage';
import { change, FakeServer, FakeStreamBody, frame, hello, json, status } from './test/fakes';

const info = { auditMode: 'replace' as const, bootChanged: false, receivedAtMs: FIXTURE_NOW_MS - 2_000 };

function entries(from: number, to: number): AuditEntryDto[] {
  const list: AuditEntryDto[] = [];
  for (let sequence = from; sequence <= to; sequence += 1) {
    list.push({ ...auditTimeline[0]!, sequence, commandId: `c${sequence}`, occurredAtMs: FIXTURE_NOW_MS + sequence });
  }
  return list;
}

describe('audit log merging', () => {
  it('appends, dedupes by sequence and keeps ascending order', () => {
    const first = applyStreamAudit(undefined, entries(1, 5), 'replace');
    const next = applyStreamAudit(first, [...entries(7, 8), ...entries(4, 6)].reverse(), 'append');
    expect(next.entries.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('replaces on a new boot or event, and when an append would leave a gap', () => {
    const first = applyStreamAudit(undefined, entries(1, 5), 'replace');
    expect(applyStreamAudit(first, entries(1, 2), 'replace').entries).toHaveLength(2);
    expect(applyStreamAudit(first, entries(9, 10), 'append').entries.map(entry => entry.sequence)).toEqual([9, 10]);
  });
});

describe('applyStreamEvent', () => {
  it('feeds status, snapshot, audit, the events list and the clock', () => {
    const queryClient = createAdminQueryClient();
    const clock = new ServerClock(() => FIXTURE_NOW_MS - 2_000);
    const summary: EventSummaryDto = { eventId: liveDispute.eventId, status: 'active', kind: 'signup',
      createdAtMs: liveDispute.createdAtMs, retiredAtMs: null, version: 3 };
    queryClient.setQueryData(adminKeys.events(), [summary]);

    applyStreamEvent(queryClient, clock, hello({ activeEventId: liveDispute.eventId, serverTimeMs: FIXTURE_NOW_MS }), info);
    expect(queryClient.getQueryData<RuntimeStatusDto>(adminKeys.status())?.serverTimeMs).toBe(FIXTURE_NOW_MS);
    expect(clock.getOffset()).toBe(2_000);

    applyStreamEvent(queryClient, clock, change(liveDispute, auditTimeline.slice(0, 10)).event, info);
    applyStreamEvent(queryClient, clock, change({ ...liveDispute, version: 18 }, auditTimeline.slice(8, 12)).event,
      { ...info, auditMode: 'append' });
    expect(queryClient.getQueryData<EventSnapshotDto>(adminKeys.snapshot(liveDispute.eventId))?.version).toBe(18);
    expect(queryClient.getQueryData<AuditLog>(adminKeys.audit(liveDispute.eventId))?.entries.map(entry => entry.sequence))
      .toEqual(auditTimeline.slice(0, 12).map(entry => entry.sequence));
    expect(queryClient.getQueryData<EventSummaryDto[]>(adminKeys.events())?.[0]?.version).toBe(18);

    applyStreamEvent(queryClient, clock, { type: 'status', status: status({ gateway: 'reconnecting' }) }, info);
    expect(queryClient.getQueryData<RuntimeStatusDto>(adminKeys.status())?.gateway).toBe('reconnecting');
  });

  it('marks the events list stale when a change names an unknown event', () => {
    const queryClient = createAdminQueryClient();
    queryClient.setQueryData(adminKeys.events(), []);
    applyStreamEvent(queryClient, new ServerClock(), change(liveDispute, []).event, info);
    expect(queryClient.getQueryState(adminKeys.events())?.isInvalidated).toBe(true);
  });

  it('resets cached snapshots and audit runs when the boot changes', () => {
    const queryClient = createAdminQueryClient();
    applyStreamEvent(queryClient, new ServerClock(), change(liveDispute, auditTimeline).event, info);
    applyStreamEvent(queryClient, new ServerClock(), hello({ bootId: 'boot-2' }), { ...info, bootChanged: true });
    expect(queryClient.getQueryData(adminKeys.snapshot(liveDispute.eventId))).toBeUndefined();
    expect(queryClient.getQueryData(adminKeys.audit(liveDispute.eventId))).toBeUndefined();
    expect(queryClient.getQueryData<RuntimeStatusDto>(adminKeys.status())?.bootId).toBe('boot-2');
  });
});

const SESSION: SessionDto = {
  principal: { kind: 'local', id: 'local-admin', label: 'Local admin' }, capabilities: ['dashboard.read'],
  expiresAtMs: 2e12, idleExpiresAtMs: 2e12, mode: 'demo', commandsEnabled: true
};

function harness(retiredAudit: AuditEntryDto[] = [], activeAudit: AuditEntryDto[] = []) {
  const server = new FakeServer();
  const bodies: FakeStreamBody[] = [];
  const retired: EventSnapshotDto = { ...final, eventId: 'retired-1', status: 'retired', retiredAtMs: FIXTURE_NOW_MS };
  server.always('GET /session', () => json(200, SESSION));
  server.always('GET /status', () => json(200, status()));
  server.always('GET /events', () => json(200, [
    { eventId: liveDispute.eventId, status: 'active', kind: 'signup', createdAtMs: 1, retiredAtMs: null, version: 17 },
    { eventId: 'retired-1', status: 'retired', kind: 'signup', createdAtMs: 0, retiredAtMs: 1, version: 24 }
  ]));
  server.always('GET /events/retired-1/snapshot', () => json(200, retired));
  const pageRoute = (source: AuditEntryDto[]) => (call: { url: string }) => {
    const params = new URL(call.url, 'http://x').searchParams;
    const after = Number(params.get('after') ?? 0);
    const limit = Number(params.get('limit') ?? 500);
    return json(200, source.filter(entry => entry.sequence > after).slice(0, limit));
  };
  server.always('GET /events/retired-1/audit', pageRoute(retiredAudit));
  server.always(`GET /events/${liveDispute.eventId}/audit`, pageRoute(activeAudit));
  server.always(`GET /events/${liveDispute.eventId}/snapshot`, () => json(200, liveDispute));
  server.always('GET /stream', () => {
    const body = new FakeStreamBody();
    bodies.push(body);
    return body.response();
  });
  const storage = createMemoryStorage();
  storage.setItem(SESSION_TOKEN_KEY, 'bearer');
  const data: AdminData = createAdminData({ fetch: server.fetch, sessionStorage: storage, location: null,
    history: null, clock: new ServerClock(), stream: { eventTarget: null, isOnline: () => true } });
  const wrapper = ({ children }: { children?: ReactNode }) => <AdminDataProvider data={data}>{children}</AdminDataProvider>;
  return { server, bodies, data, wrapper };
}

describe('query hooks', () => {
  it('drive the active snapshot and audit from the stream', async () => {
    const { bodies, wrapper, server } = harness();
    const { result } = renderHook(() => {
      const active = useActiveSnapshot();
      return { active, audit: useAudit(active.eventId), connection: useStreamConnection(), status: useRuntimeStatus() };
    }, { wrapper });
    await waitFor(() => expect(bodies).toHaveLength(1));

    const first = change(liveDispute, auditTimeline.slice(0, 15));
    await act(async () => {
      bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id));
    });
    await waitFor(() => expect(result.current.audit.entries).toHaveLength(15));
    expect(result.current.connection.state).toBe('live');
    expect(result.current.active).toMatchObject({ eventId: liveDispute.eventId, status: 'ready' });
    expect(result.current.audit.live).toBe(true);
    expect(result.current.audit.hasOlder).toBe(false);
    expect(result.current.status.data?.buildId).toBe('build-1');

    const next = change({ ...liveDispute, version: 19 }, auditTimeline.slice(13, 17));
    await act(async () => { bodies[0]!.push(frame(next.event, next.id)); });
    await waitFor(() => expect(result.current.active.snapshot?.version).toBe(19));
    expect(result.current.audit.entries.map(entry => entry.sequence)).toEqual(auditTimeline.map(entry => entry.sequence));
    // The stream fed the active audit; no HTTP audit read was needed once it was live.
    expect(server.calls.filter(call => call.url.includes('/audit')).length).toBeLessThanOrEqual(1);
  });

  it('backfills the active audit with fetchOlder', async () => {
    const all = entries(1, 600);
    const { bodies, wrapper } = harness([], all);
    const { result } = renderHook(() => useAudit(liveDispute.eventId), { wrapper });
    await waitFor(() => expect(result.current.entries).toHaveLength(500));   // HTTP head before the stream
    await waitFor(() => expect(bodies).toHaveLength(1));
    const tail = change(liveDispute, all.slice(400));
    await act(async () => {
      bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(tail.event, tail.id));
    });
    await waitFor(() => expect(result.current.entries[0]?.sequence).toBe(401));
    expect(result.current.hasOlder).toBe(true);
    await act(async () => { await result.current.fetchOlder(); });
    expect(result.current.entries).toHaveLength(600);
    expect(result.current.entries[0]!.sequence).toBe(1);
    expect(result.current.hasOlder).toBe(false);
  });

  it('pages a retired event over HTTP with fetchMore, and fetches its snapshot', async () => {
    const all = entries(1, 520);
    const { wrapper } = harness(all);
    const { result } = renderHook(() => ({ audit: useAudit('retired-1', 100), snapshot: useEventSnapshot('retired-1'),
      events: useEvents() }), { wrapper });
    await waitFor(() => expect(result.current.audit.entries).toHaveLength(500));
    expect(result.current.audit.live).toBe(false);
    expect(result.current.audit.hasMore).toBe(true);
    await act(async () => { await result.current.audit.fetchMore(); });
    expect(result.current.audit.entries).toHaveLength(520);
    expect(result.current.audit.hasMore).toBe(false);
    await waitFor(() => expect(result.current.snapshot.data?.status).toBe('retired'));
    expect(result.current.events.data).toHaveLength(2);
  });

  it('falls back to the events list for the active event before hello', async () => {
    const { wrapper } = harness();
    const { result } = renderHook(() => useActiveSnapshot(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.eventId).toBe(liveDispute.eventId);
  });
});

describe('caches of events that are no longer active (Wave 2 review)', () => {
  it('drops the previous active event when a new one takes over, so it is re-read as retired', () => {
    const queryClient = createAdminQueryClient();
    const clock = new ServerClock();
    applyStreamEvent(queryClient, clock, change(liveDispute, auditTimeline).event, info);
    expect(queryClient.getQueryData(adminKeys.snapshot(liveDispute.eventId))).toBeDefined();
    const next = { ...liveDispute, eventId: 'event-2', version: 1 };
    applyStreamEvent(queryClient, clock, change(next, []).event, info);
    // Unobserved: removed (no stale "active" copy, no unbounded growth).
    expect(queryClient.getQueryData(adminKeys.snapshot(liveDispute.eventId))).toBeUndefined();
    expect(queryClient.getQueryData(adminKeys.audit(liveDispute.eventId))).toBeUndefined();
    expect(queryClient.getQueryData(adminKeys.snapshot('event-2'))).toBeDefined();
  });

  it('refetches the previous active event when someone is looking at it', async () => {
    const { bodies, wrapper, server } = harness();
    const retiredCopy = { ...liveDispute, status: 'retired' as const, retiredAtMs: FIXTURE_NOW_MS, version: 18 };
    const { result } = renderHook(() => useEventSnapshot(liveDispute.eventId), { wrapper });
    await waitFor(() => expect(bodies).toHaveLength(1));
    const first = change(liveDispute, []);
    await act(async () => { bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id)); });
    await waitFor(() => expect(result.current.data?.status).toBe('active'));
    server.always(`GET /events/${liveDispute.eventId}/snapshot`, () => json(200, retiredCopy));
    const next = change({ ...liveDispute, eventId: 'event-2', version: 1 }, []);
    await act(async () => { bodies[0]!.push(frame(next.event, next.id)); });
    await waitFor(() => expect(result.current.data?.status).toBe('retired'));
  });

  it('takes a retired copy at the same version over the cached active one (Wave 3 QA)', async () => {
    // Retirement does not bump the version, and retired snapshots carry panel revision 0.
    const active = { ...liveDispute, panelRevision: 3 };
    const retiredCopy = { ...active, status: 'retired' as const, retiredAtMs: FIXTURE_NOW_MS, panelRevision: 0 };
    expect(isSnapshotNewer(retiredCopy, active)).toBe(true);
    expect(isSnapshotNewer(active, retiredCopy)).toBe(false);
    expect(isSnapshotNewer({ ...active, panelRevision: 2 }, active)).toBe(false);
    const { bodies, wrapper, server } = harness();
    const { result } = renderHook(() => useEventSnapshot(active.eventId), { wrapper });
    await waitFor(() => expect(bodies).toHaveLength(1));
    const first = change(active, []);
    await act(async () => { bodies[0]!.push(frame(hello({ activeEventId: active.eventId })) + frame(first.event, first.id)); });
    await waitFor(() => expect(result.current.data?.status).toBe('active'));
    server.always(`GET /events/${active.eventId}/snapshot`, () => json(200, retiredCopy));
    const next = change({ ...liveDispute, eventId: 'event-2', version: 1 }, []);
    await act(async () => { bodies[0]!.push(frame(next.event, next.id)); });
    await waitFor(() => expect(result.current.data?.status).toBe('retired'));
  });

  it('gives non-active events a finite gcTime', async () => {
    const { data, wrapper } = harness();
    const { result } = renderHook(() => useEventSnapshot('retired-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('retired'));
    const query = data.queryClient.getQueryCache().find({ queryKey: adminKeys.snapshot('retired-1'), exact: true });
    expect(query?.gcTime).toBe(INACTIVE_EVENT_GC_MS);
  });
});
