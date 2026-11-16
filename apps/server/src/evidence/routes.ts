// Evidence HTTP routes. Link and text-note evidence, hold, delete and the reply thread are implemented here;
// binary upload, playback tickets and media streaming are typed seams (EvidenceRouteSeams) that answer 501
// until provided, and Discord delivery of replies is the EvidenceReplyDelivery option.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateEvidenceResponseDto, EvidenceItemDto, EvidenceItemResponseDto, EvidenceListDto, EvidenceReplyListDto,
  EvidenceReplyResponseDto, MatchId, PlaybackTicketDto } from '@tcg-live/core';
import { readJsonBody, strictObject } from '../admin/http/body.js';
import { HttpError, sendJson } from '../admin/http/respond.js';
import type { Session } from '../admin/http/sessions.js';
import { LOCAL_ADMIN, type OpsActor, type OpsAuditStore } from '../ops/audit.js';
import { mapOpsError } from '../ops/errors.js';
import { badRequest, notImplemented, onlyParams, UUID, type OpsContext, type OpsRoute } from '../ops/http.js';
import { attemptReplyDelivery, type EvidenceReplyDelivery } from './replies.js';
import type { EvidenceRecord, EvidenceStore } from './store.js';

const UPLOAD_PATH = /^\/api\/v1\/events\/[^/]+\/matches\/[^/]+\/evidence(?:\?.*)?$/;
/**
 * True for a dashboard evidence file upload (POST to a match's evidence with a non-JSON body). The HTTP
 * server gives these an idle timeout instead of the total request deadline: a 2 GiB file can take far
 * longer than five minutes on a slow link.
 */
export function isEvidenceUploadRequest(request: Pick<IncomingMessage, 'method' | 'url' | 'headers'>): boolean {
  if (request.method !== 'POST' || !request.url || !UPLOAD_PATH.test(request.url)) return false;
  const type = request.headers['content-type'];
  return type !== undefined && type.split(';')[0]!.trim().toLowerCase() !== 'application/json';
}

export const EVIDENCE_UNAVAILABLE = 'Evidence storage is unavailable. Check PostgreSQL, then restart with npm start or run npm run db:evidence-setup.';
const MATCH = /^M[1-9]\d{0,3}$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export interface EvidenceUploadContext {
  request: IncomingMessage;
  eventId: string;
  matchId: MatchId;
  /** Always the local dashboard admin for HTTP uploads. */
  actor: OpsActor;
  /** From `?note=`; already validated by the store when passed through. */
  note: string | undefined;
  store: EvidenceStore;
}
export interface EvidencePlaybackContext {
  record: EvidenceRecord;
  session: Session;
  /** True while the issuing session is signed in; tickets must stop working once it is false. */
  sessionLive(): boolean;
}
export interface EvidenceMediaContext {
  request: IncomingMessage;
  response: ServerResponse;
  ticket: string;
  head: boolean;
  /** `?download=1` asks for Content-Disposition: attachment. */
  download: boolean;
}

/** Later-phase implementations plug in here without editing the route table. */
export interface EvidenceRouteSeams {
  /** POST /api/v1/events/:id/matches/:m/evidence with a media Content-Type. Streams, sniffs, hashes, stores. */
  upload?(context: EvidenceUploadContext): Promise<EvidenceItemDto & { duplicate?: boolean }>;
  /** POST /api/v1/evidence/:id/playback for a stored file. The route audits evidence.viewed afterwards. */
  playback?(context: EvidencePlaybackContext): Promise<PlaybackTicketDto>;
  /** GET/HEAD /api/v1/media/:ticket (public: the ticket authenticates). Range requests, containment checks. */
  media?(context: EvidenceMediaContext): Promise<void>;
  /** Removes a soft-deleted item's file; best effort after the delete commits. */
  removeFile?(record: EvidenceRecord): Promise<void>;
}

export interface EvidenceRouteOptions {
  store: EvidenceStore;
  audit: OpsAuditStore;
  seams?: EvidenceRouteSeams;
  /**
   * Posts 'players' replies to Discord. Without it a players reply is refused (503) before anything is stored;
   * staff-only replies never need it.
   */
  replyDelivery?: EvidenceReplyDelivery;
  /** Supplied by the admin handler. */
  sessionLive?: (session: Session) => boolean;
}

function eventMatch(params: string[]): { eventId: string; matchId: MatchId } {
  const [eventId, matchId] = params;
  if (!eventId || !UUID.test(eventId)) throw badRequest('Invalid event ID.');
  if (!matchId || !MATCH.test(matchId)) throw badRequest('Invalid match ID.');
  return { eventId: eventId.toLowerCase(), matchId: matchId as MatchId };
}
function evidenceId(raw: string | undefined): string {
  if (!raw || !UUID.test(raw)) throw new HttpError(404, 'not_found', 'Evidence not found.');
  return raw.toLowerCase();
}
function isJson(request: IncomingMessage): boolean {
  const type = request.headers['content-type'];
  return type === undefined || type.split(';')[0]!.trim().toLowerCase() === 'application/json';
}
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { return mapOpsError(error, EVIDENCE_UNAVAILABLE); }
}

export function evidenceRoutes(options: EvidenceRouteOptions): OpsRoute[] {
  const { store, audit, seams = {}, replyDelivery } = options;
  return [
    { pattern: /^\/api\/v1\/events\/([^/]+)\/matches\/([^/]+)\/evidence$/, methods: {
      GET: { access: 'evidence.read', run: async ({ response, params, query }) => {
        onlyParams(query, []);
        const where = eventMatch(params);
        const items = await guarded(() => store.list(where.eventId, where.matchId));
        const body: EvidenceListDto = { ...where, items };
        sendJson(response, 200, body);
      } },
      POST: { access: 'evidence.manage', run: async ({ request, response, params, query }) => {
        const where = eventMatch(params);
        if (request.headers['content-type'] === undefined) { request.resume(); throw new HttpError(415, 'bad_request', 'Send links as application/json and files with their media Content-Type.'); }
        if (!isJson(request)) {
          onlyParams(query, ['note']);
          if (!seams.upload) { request.resume(); throw notImplemented('File upload'); }
          const upload = seams.upload;
          const { duplicate, ...item } = await guarded(() => upload({ request, ...where, actor: LOCAL_ADMIN, note: query.get('note') ?? undefined, store }));
          // A duplicate stores nothing: 200 with the earlier item instead of 201.
          const body: CreateEvidenceResponseDto = duplicate ? { item, duplicate: true } : { item };
          sendJson(response, duplicate ? 200 : 201, body);
          return;
        }
        onlyParams(query, []);
        const fields = strictObject(await readJsonBody(request), ['kind', 'url', 'note', 'text']);
        if (fields.kind !== undefined && fields.kind !== 'link' && fields.kind !== 'note') throw badRequest('kind must be "link" or "note".');
        let item: EvidenceItemDto;
        if (fields.kind === 'note') {
          if (fields.url !== undefined || fields.note !== undefined) throw badRequest('A text note takes only text.');
          item = await guarded(() => store.createNote({ ...where, text: fields.text as string, source: 'web', submittedBy: 'local-admin', actor: LOCAL_ADMIN }));
        } else {
          if (fields.text !== undefined) throw badRequest('text is only for kind "note".');
          item = await guarded(() => store.createLink({ ...where, url: fields.url as string, note: fields.note as string | undefined,
            source: 'web', submittedBy: 'local-admin', actor: LOCAL_ADMIN }));
        }
        const body: CreateEvidenceResponseDto = { item };
        sendJson(response, 201, body);
      } }
    } },
    { pattern: /^\/api\/v1\/events\/([^/]+)\/matches\/([^/]+)\/evidence\/replies$/, methods: {
      GET: { access: 'evidence.read', run: async ({ response, params, query }) => {
        onlyParams(query, []);
        const where = eventMatch(params);
        const replies = await guarded(() => store.listReplies(where.eventId, where.matchId));
        const body: EvidenceReplyListDto = { ...where, replies };
        sendJson(response, 200, body);
      } },
      // match.judge, not evidence.manage: answering players is a match action, and read-only sessions (dashboard
      // actions off) hold neither. Staff-only replies need it too, so the thread has one rule.
      POST: { access: 'match.judge', run: async ({ request, response, params, query }) => {
        onlyParams(query, []);
        const where = eventMatch(params);
        const { body, audience } = strictObject(await readJsonBody(request), ['body', 'audience']);
        if (audience === 'players' && !replyDelivery)
          throw new HttpError(503, 'unavailable', 'Discord delivery is not available. Send a staff-only note, or try again when the bot is online.');
        const created = await guarded(() => store.createReply({ ...where, body: body as string, audience: audience as 'players' | 'staff',
          author: 'local-admin', actor: LOCAL_ADMIN }));
        const { attempt: _token, ...plain } = created;
        const reply = created.status === 'pending'
          ? await guarded(() => attemptReplyDelivery(store, replyDelivery!, created, LOCAL_ADMIN)) : plain;
        const result: EvidenceReplyResponseDto = { reply };
        sendJson(response, 201, result);
      } }
    } },
    { pattern: /^\/api\/v1\/events\/([^/]+)\/matches\/([^/]+)\/evidence\/replies\/([^/]+)\/retry$/, methods: {
      POST: { access: 'match.judge', run: async ({ request, response, params }) => {
        const where = eventMatch(params);
        const id = params[2];
        if (!id || !UUID.test(id)) throw new HttpError(404, 'not_found', 'Reply not found.');
        strictObject(await readJsonBody(request) ?? {}, []);
        if (!replyDelivery) throw new HttpError(503, 'unavailable', 'Discord delivery is not available. Try again when the bot is online.');
        const existing = await guarded(() => store.getReply(id));
        if (!existing || existing.eventId !== where.eventId || existing.matchId !== where.matchId)
          throw new HttpError(404, 'not_found', 'Reply not found.');
        const claimed = await guarded(() => store.claimReplyRetry(id, LOCAL_ADMIN));
        const reply = await guarded(() => attemptReplyDelivery(store, replyDelivery, claimed, LOCAL_ADMIN));
        const result: EvidenceReplyResponseDto = { reply };
        sendJson(response, 200, result);
      } }
    } },
    { pattern: /^\/api\/v1\/evidence\/([^/]+)$/, methods: {
      PATCH: { access: 'evidence.manage', run: async ({ request, response, params }) => {
        const id = evidenceId(params[0]);
        const { hold } = strictObject(await readJsonBody(request), ['hold']);
        if (typeof hold !== 'boolean') throw badRequest('hold must be true or false.');
        const item = await guarded(() => store.setHold(id, hold, LOCAL_ADMIN));
        const body: EvidenceItemResponseDto = { item };
        sendJson(response, 200, body);
      } },
      DELETE: { access: 'evidence.manage', run: async ({ request, response, params }) => {
        const id = evidenceId(params[0]);
        const { reason } = strictObject(await readJsonBody(request), ['reason']);
        const record = await guarded(() => store.softDelete(id, reason as string, LOCAL_ADMIN));
        if (record.storagePath && seams.removeFile) {
          try { await seams.removeFile(record); } catch { /* Retention retries file removal for deleted rows. */ }
        }
        const { storagePath: _omit, ...item } = record;
        const body: EvidenceItemResponseDto = { item };
        sendJson(response, 200, body);
      } }
    } },
    { pattern: /^\/api\/v1\/evidence\/([^/]+)\/playback$/, methods: {
      POST: { access: 'evidence.read', run: async ({ request, response, params, session }: OpsContext) => {
        const id = evidenceId(params[0]);
        strictObject(await readJsonBody(request) ?? {}, []);
        if (!seams.playback) throw notImplemented('Playback');
        const record = await guarded(() => store.get(id));
        if (!record) throw new HttpError(404, 'not_found', 'Evidence not found.');
        if (record.kind === 'note') throw badRequest('A text note has no recording to play.');
        if (record.status !== 'stored' || !record.storagePath) throw new HttpError(409, 'conflict', 'Only stored files can be played.');
        const live = options.sessionLive ?? (() => true);
        const ticket = await seams.playback({ record, session: session!, sessionLive: () => live(session!) });
        await guarded(() => audit.append({ kind: 'evidence.viewed', actor: LOCAL_ADMIN, eventId: record.eventId,
          payload: { evidenceId: record.id, matchId: record.matchId } }));
        sendJson(response, 200, ticket);
      } }
    } },
    { pattern: /^\/api\/v1\/media\/([^/]+)$/, methods: Object.fromEntries((['GET', 'HEAD'] as const).map(method => [method, {
      access: 'public' as const, run: async ({ request, response, params, query }: OpsContext) => {
        const ticket = params[0] ?? '';
        onlyParams(query, ['download']);
        if (!TICKET.test(ticket)) throw new HttpError(404, 'not_found', 'Not found.');
        if (!seams.media) throw notImplemented('Media playback');
        await seams.media({ request, response, ticket, head: method === 'HEAD', download: query.get('download') === '1' });
      } }])) }
  ];
}
