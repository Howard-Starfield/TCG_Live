// Test doubles for the data layer: a scripted fetch, pushable SSE response bodies, frames, storage.
import { formatStreamFrame, formatStreamId, type AuditEntryDto, type EventSnapshotDto, type RuntimeStatusDto,
  type StreamEventDto } from '@tcg-live/core';
import { FIXTURE_BOOT_ID, FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import type { FetchLike } from '../client';

const encoder = new TextEncoder();

/** A text/event-stream body the test pushes chunks into. */
export class FakeStreamBody {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  cancelled = false;
  readonly stream = new ReadableStream<Uint8Array>({
    start: controller => { this.controller = controller; },
    cancel: () => { this.cancelled = true; }
  });

  push(text: string): void {
    if (!this.cancelled) this.controller.enqueue(encoder.encode(text));
  }

  end(): void {
    if (!this.cancelled) this.controller.close();
  }

  response(): Response {
    return new Response(this.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
}

/** One recorded fetch call. */
export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

type Route = (call: FetchCall) => Response | Promise<Response>;

/** A scripted fetch: routes by `METHOD path` (path relative to /api/v1, query string stripped). */
export class FakeServer {
  readonly calls: FetchCall[] = [];
  private readonly routes = new Map<string, Route[]>();
  private readonly fallbacks = new Map<string, Route>();

  /** Queues a one-shot response for `METHOD /path`. */
  once(key: string, route: Route): this {
    const queue = this.routes.get(key) ?? [];
    queue.push(route);
    this.routes.set(key, queue);
    return this;
  }

  /** Sets the response used when no one-shot response is queued. */
  always(key: string, route: Route): this {
    this.fallbacks.set(key, route);
    return this;
  }

  callsTo(key: string): FetchCall[] {
    return this.calls.filter(call => `${call.method} ${pathOf(call.url)}` === key);
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const call: FetchCall = {
      url: input,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined
    };
    this.calls.push(call);
    if (call.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const key = `${call.method} ${pathOf(input)}`;
    const route = this.routes.get(key)?.shift() ?? this.fallbacks.get(key);
    if (!route) return json(404, { error: { code: 'not_found', message: `No fake route for ${key}` } });
    return route(call);
  };
}

function pathOf(url: string): string {
  return url.replace(/^.*\/api\/v1/, '').replace(/\?.*$/, '');
}

/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers }
  });
}

/** A `204 No Content` response. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** The server's own encoder, so client tests read exactly the wire format the server writes. */
export const frame = formatStreamFrame;

export function status(overrides: Partial<RuntimeStatusDto> = {}): RuntimeStatusDto {
  return {
    mode: 'demo', bootId: FIXTURE_BOOT_ID, buildId: 'build-1', serverTimeMs: FIXTURE_NOW_MS,
    startedAtMs: FIXTURE_NOW_MS - 60_000, gateway: 'not_applicable', database: 'not_configured',
    lease: 'not_applicable', cards: { updatePending: false }, rooms: { enabled: false, warning: null },
    commandsEnabled: true, ...overrides
  };
}

export function hello(overrides: { buildId?: string; bootId?: string; activeEventId?: string | null;
  serverTimeMs?: number } = {}): StreamEventDto {
  const bootId = overrides.bootId ?? FIXTURE_BOOT_ID;
  const buildId = overrides.buildId ?? 'build-1';
  return {
    type: 'hello', apiVersion: 1, buildId, bootId,
    status: status({ bootId, buildId, ...(overrides.serverTimeMs === undefined ? {} : { serverTimeMs: overrides.serverTimeMs }) }),
    activeEventId: overrides.activeEventId === undefined ? null : overrides.activeEventId
  };
}

/** A `change` event plus its wire id. */
export function change(snapshot: EventSnapshotDto, audit: AuditEntryDto[], bootId = FIXTURE_BOOT_ID):
  { event: StreamEventDto; id: string } {
  return {
    event: { type: 'change', eventId: snapshot.eventId, version: snapshot.version,
      panelRevision: snapshot.panelRevision, snapshot, audit },
    id: formatStreamId({ bootId, eventId: snapshot.eventId, version: snapshot.version, panelRevision: snapshot.panelRevision })
  };
}

/** Lets pending promise callbacks (fetch, body reads) run. Real timers only. */
export async function flush(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
}
