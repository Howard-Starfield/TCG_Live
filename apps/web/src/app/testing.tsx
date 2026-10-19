// Test harness for the shell: a real data layer over a scripted fetch, fixtures, and in-memory preferences.
import { CAPABILITIES, type AuditEntryDto, type EventSnapshotDto, type EventSummaryDto, type RuntimeStatusDto,
  type SessionDto } from '@tcg-live/core';
import { auditTimeline, FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { render } from '@testing-library/react';
import { createAdminData, createMemoryStorage, PreferencesStore, ServerClock, SESSION_TOKEN_KEY,
  type AdminData, type PreferencesPatch } from '../data';
import { change, FakeServer, FakeStreamBody, frame, hello, json, noContent, status as statusFixture } from '../data/test/fakes';
import { AppRoot } from './AppRoot';

export const sessionFixture: SessionDto = {
  principal: { kind: 'local', id: 'local-admin', label: 'Local admin' },
  capabilities: [...CAPABILITIES],
  expiresAtMs: FIXTURE_NOW_MS + 12 * 3_600_000,
  idleExpiresAtMs: FIXTURE_NOW_MS + 2 * 3_600_000,
  mode: 'demo',
  commandsEnabled: true
};

export function summaryOf(snapshot: EventSnapshotDto): EventSummaryDto {
  return { eventId: snapshot.eventId, status: snapshot.status, kind: snapshot.kind, createdAtMs: snapshot.createdAtMs,
    retiredAtMs: snapshot.retiredAtMs, version: snapshot.version };
}

export interface HarnessOptions {
  /** Start with a stored bearer token (validated with GET /session). Default true. */
  signedIn?: boolean;
  snapshot?: EventSnapshotDto | null;
  audit?: AuditEntryDto[];
  status?: Partial<RuntimeStatusDto>;
  /** Extra (retired) snapshots, listed after the active one. */
  retired?: EventSnapshotDto[];
  /** Whether the stream opens and delivers hello + change. Default true. */
  stream?: boolean;
  /** `activeEventId` in hello; defaults to the snapshot's ID. */
  helloActiveEventId?: string | null;
  preferences?: PreferencesPatch;
  /** Extra routes, registered before anything renders (one-shot routes win over the defaults). */
  setup?: (server: FakeServer) => void;
}

export interface Harness {
  data: AdminData;
  server: FakeServer;
  preferences: PreferencesStore;
  /** Stream bodies, one per connection. */
  bodies: FakeStreamBody[];
  storage: ReturnType<typeof createMemoryStorage>;
}

/** Builds the data layer and preferences without rendering. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const snapshot = options.snapshot === undefined ? liveDispute : options.snapshot;
  const audit = options.audit ?? auditTimeline;
  const retired = options.retired ?? [];
  const server = new FakeServer();
  const storage = createMemoryStorage();
  if (options.signedIn ?? true) storage.setItem(SESSION_TOKEN_KEY, 'bearer-token');

  server.always('GET /session', () => json(200, sessionFixture));
  server.always('POST /session', () => json(200, { token: 'bearer-token', session: sessionFixture }));
  server.always('DELETE /session', () => noContent());
  server.always('POST /session/rotate-link', () => noContent());
  server.always('GET /status', () => json(200, statusFixture(options.status)));
  server.always('GET /events', () => json(200, [...(snapshot ? [summaryOf(snapshot)] : []), ...retired.map(summaryOf)]));
  for (const item of [...(snapshot ? [snapshot] : []), ...retired]) {
    server.always(`GET /events/${item.eventId}/snapshot`, () => json(200, item));
    server.always(`GET /events/${item.eventId}/audit`, () => json(200, item === snapshot ? audit : audit.slice(0, 5)));
  }

  const bodies: FakeStreamBody[] = [];
  if (options.stream ?? true) {
    server.always('GET /stream', () => {
      const body = new FakeStreamBody();
      bodies.push(body);
      const helloEvent = hello({ activeEventId: options.helloActiveEventId === undefined ? snapshot?.eventId ?? null : options.helloActiveEventId });
      if (helloEvent.type === 'hello' && options.status) helloEvent.status = { ...helloEvent.status, ...options.status };
      body.push(frame(helloEvent));
      if (snapshot && options.helloActiveEventId !== null) {
        const { event, id } = change(snapshot, audit);
        body.push(frame(event, id));
      }
      return body.response();
    });
  } else {
    server.always('GET /stream', () => new Promise<Response>(() => {}));
  }

  options.setup?.(server);

  const data = createAdminData({
    fetch: server.fetch, sessionStorage: storage, location: null, history: null,
    clock: new ServerClock(() => FIXTURE_NOW_MS), expectedBuildId: null, reload: () => {},
    stream: { eventTarget: null, isOnline: () => true, random: () => 0, now: () => FIXTURE_NOW_MS }
  });
  const preferences = new PreferencesStore(createMemoryStorage(), null);
  // Tests start with closed panes unless they say otherwise.
  preferences.update({ panes: { live: false, list: false }, ...options.preferences });
  return { data, server, preferences, storage, bodies };
}

/** Renders the whole app over a harness. */
export function renderConsole(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  const view = render(<AppRoot data={harness.data} preferences={harness.preferences} />);
  return { ...harness, ...view };
}

/** Makes `matchMedia(query)` match for queries containing `needle` (others never match). */
export function mockMatchMedia(matches: (query: string) => boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: matches(query), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false
  });
  return () => { window.matchMedia = original; };
}
