// Dev and test helper (not exported from index.tsx, never imported by production code): a real
// AdminData wired to an in-memory fake API serving fixture snapshots, audit pages and a stream.
import { formatStreamFrame as frame, formatStreamId, type AuditEntryDto, type EventSnapshotDto,
  type RuntimeStatusDto, type SessionDto } from '@tcg-live/core';
import { FIXTURE_BOOT_ID, FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { useState, type ReactNode } from 'react';
import { AdminDataProvider, createAdminData, createMemoryStorage, ServerClock, SESSION_TOKEN_KEY,
  type AdminData, type FetchLike } from '../../data';

export interface FixtureDataOptions {
  snapshot: EventSnapshotDto;
  /** Every applied entry the fake server knows, ascending. */
  audit?: AuditEntryDto[];
  /**
   * Make the event active and deliver the last `liveTail` entries over the stream. The HTTP head
   * page (500) loads first, so "Load older" appears only when the tail starts past that page.
   * Omit to treat the event as not streamed: the audit is paged over HTTP ("Load newer").
   */
  liveTail?: number;
  /** `pending`: the audit never loads; `error`: it fails with a non-retried 404. */
  auditMode?: 'ok' | 'pending' | 'error';
  status?: Partial<RuntimeStatusDto>;
  /** `pending`: runtime status never arrives (neither over HTTP nor the stream). */
  statusMode?: 'ok' | 'pending';
  /** Local clock for the server clock (defaults to Date.now, so countdowns tick). */
  localNow?: () => number;
}

export interface FixtureData {
  data: AdminData;
  /** Recorded request paths with query strings, e.g. `GET /events/x/audit?after=0&limit=500`. */
  calls: string[];
}

const SESSION: SessionDto = {
  principal: { kind: 'local', id: 'local-admin', label: 'Local admin' },
  capabilities: ['dashboard.read', 'event.publish', 'signup.manage', 'match.judge', 'match.correct', 'panels.refresh'],
  expiresAtMs: FIXTURE_NOW_MS + 12 * 3_600_000, idleExpiresAtMs: FIXTURE_NOW_MS + 2 * 3_600_000,
  mode: 'demo', commandsEnabled: false
};

export function fixtureStatus(overrides: Partial<RuntimeStatusDto> = {}): RuntimeStatusDto {
  return {
    mode: 'demo', bootId: FIXTURE_BOOT_ID, buildId: 'lists-fixture', serverTimeMs: FIXTURE_NOW_MS,
    startedAtMs: FIXTURE_NOW_MS - 3_600_000, gateway: 'ready', database: 'ready', lease: 'held',
    cards: { updatePending: false }, rooms: { enabled: true, warning: null }, commandsEnabled: false, ...overrides
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const never = () => new Promise<Response>(() => {});

/** Creates AdminData whose fetch is served from fixtures. Signed in from the start. */
export function createFixtureData(options: FixtureDataOptions): FixtureData {
  const { snapshot, audit = [], liveTail, auditMode = 'ok', statusMode = 'ok' } = options;
  const status = fixtureStatus(options.status);
  const calls: string[] = [];
  const encoder = new TextEncoder();
  const auditPath = `/events/${encodeURIComponent(snapshot.eventId)}/audit`;

  const fetch: FetchLike = async (input, init = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(input, 'http://fixture.local');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    calls.push(`${method} ${path}${url.search}`);
    if (method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'Read-only fixture' } });
    if (path === '/session') return json(200, SESSION);
    if (path === '/status') return statusMode === 'pending' ? never() : json(200, status);
    if (path === '/events') {
      return json(200, [{ eventId: snapshot.eventId, status: snapshot.status, kind: snapshot.kind,
        createdAtMs: snapshot.createdAtMs, retiredAtMs: snapshot.retiredAtMs, version: snapshot.version }]);
    }
    if (path === `/events/${encodeURIComponent(snapshot.eventId)}/snapshot`) return json(200, snapshot);
    if (path === auditPath) {
      if (auditMode === 'pending') return never();
      if (auditMode === 'error') return json(404, { error: { code: 'not_found', message: 'The audit is unavailable.' } });
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 500);
      return json(200, audit.filter(entry => entry.sequence > after).slice(0, limit));
    }
    if (path === '/stream') {
      if (statusMode === 'pending') return never();
      const live = liveTail !== undefined;
      let text = frame({ type: 'hello', apiVersion: 1, buildId: status.buildId, bootId: status.bootId, status,
        activeEventId: live ? snapshot.eventId : null });
      if (live) {
        const cursor = { bootId: status.bootId, eventId: snapshot.eventId, version: snapshot.version, panelRevision: snapshot.panelRevision };
        text += frame({ type: 'change', eventId: snapshot.eventId, version: snapshot.version, panelRevision: snapshot.panelRevision,
          snapshot, audit: liveTail > 0 ? audit.slice(-liveTail) : [] }, formatStreamId(cursor));
      }
      const body = new ReadableStream<Uint8Array>({ start: controller => controller.enqueue(encoder.encode(text)) });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(404, { error: { code: 'not_found', message: `No fixture route for ${path}` } });
  };

  const storage = createMemoryStorage();
  storage.setItem(SESSION_TOKEN_KEY, 'fixture-bearer');
  const data = createAdminData({
    fetch, sessionStorage: storage, location: null, history: null,
    clock: new ServerClock(options.localNow), expectedBuildId: status.buildId, reload: () => {},
    stream: { eventTarget: null, isOnline: () => true }
  });
  return { data, calls };
}

/** Provides fixture-backed AdminData to its children (created once per mount). */
export function FixtureDataProvider({ children, ...options }: FixtureDataOptions & { children?: ReactNode }) {
  const [fixture] = useState(() => createFixtureData(options));
  return <AdminDataProvider data={fixture.data}>{children}</AdminDataProvider>;
}

/**
 * A long synthetic audit (for paging): the fixture timeline followed by clock checks from every seat,
 * with an occasional CLI admin entry and timer check so every actor kind and source appears.
 */
export function syntheticAudit(base: readonly AuditEntryDto[], count: number): AuditEntryDto[] {
  const list = [...base];
  const seats = ['A', 'B', 'C', 'D'] as const;
  let at = base[base.length - 1]?.occurredAtMs ?? FIXTURE_NOW_MS;
  for (let sequence = base.length + 1; list.length < count; sequence += 1) {
    at += 3_000;
    const seat = seats[sequence % 4]!;
    const matchId = seat === 'A' || seat === 'B' ? 'M1' as const : 'M2' as const;
    const entry: AuditEntryDto = sequence % 50 === 0
      ? { sequence, commandId: `cli:${sequence}`, occurredAtMs: at, actor: { kind: 'admin' }, via: 'cli', principalId: null,
        command: { type: 'clockCheck', matchId }, result: 'clockCheck', mode: 'CAM' }
      : sequence % 37 === 0
        ? { sequence, commandId: `timer:${matchId}:0:${at}`, occurredAtMs: at, actor: { kind: 'system', source: 'timer' }, via: 'system',
          principalId: null, command: { type: 'clockCheck', matchId }, result: 'clockCheck', mode: 'CAM' }
        : { sequence, commandId: `interaction:${sequence}`, occurredAtMs: at, actor: { kind: 'player', seat }, via: 'discord',
          principalId: null, command: { type: 'clockCheck', matchId }, result: 'clockCheck', mode: 'CAM' };
    list.push(entry);
  }
  return list;
}
