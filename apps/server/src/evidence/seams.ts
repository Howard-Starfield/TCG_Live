// The concrete EvidenceRouteSeams: dashboard upload, playback tickets, ranged media and file removal.
import type { IncomingMessage } from 'node:http';
import { EVIDENCE_ADMIN_MAX_BYTES } from '@tcg-live/core';
import { HttpError } from '../admin/http/respond.js';
import { EvidenceFileError, EvidenceFiles, sharedEvidenceFiles, type EvidenceDiskOptions } from './files.js';
import { serveEvidenceFile } from './range.js';
import type { EvidenceRouteSeams } from './routes.js';
import { PlaybackTickets, type PlaybackTicketOptions } from './tickets.js';

export interface EvidenceSeamOptions extends EvidenceDiskOptions {
  /** Per-file cap for dashboard uploads. */
  adminMaxBytes?: number;
  tickets?: PlaybackTicketOptions;
}

export interface EvidenceSeamBundle {
  seams: Required<EvidenceRouteSeams>;
  files: EvidenceFiles;
  tickets: PlaybackTickets;
}

function declaredLength(request: IncomingMessage): number | null {
  const raw = request.headers['content-length'];
  return raw !== undefined && /^\d{1,16}$/.test(raw) ? Number(raw) : null;
}

/** EvidenceFileError and interrupted uploads become safe HTTP errors; store errors pass to the route's mapper. */
export function uploadHttpError(error: unknown, request?: IncomingMessage): unknown {
  // Connection: close on every refusal: the client may still be sending a large body, and a fresh
  // connection for its next request is safer than draining gigabytes. The message is always readable.
  if (error instanceof EvidenceFileError)
    return new HttpError(error.status, error.status === 500 ? 'internal' : 'bad_request', error.message, { Connection: 'close' });
  if (error instanceof HttpError) return error;
  if (request && (request.destroyed || request.readableAborted || (error as { code?: string })?.code === 'ECONNRESET'))
    return new HttpError(400, 'bad_request', 'The upload was interrupted.', { Connection: 'close' });
  return error;
}

export function createEvidenceSeams(options: EvidenceSeamOptions = {}): EvidenceSeamBundle {
  const { adminMaxBytes: _cap, tickets: _tickets, ...disk } = options;
  // Default options share the process-wide quota account with Discord attachments and voice recordings.
  const files = Object.keys(disk).length ? new EvidenceFiles(disk) : sharedEvidenceFiles();
  const tickets = new PlaybackTickets(options.tickets);
  const adminMaxBytes = options.adminMaxBytes ?? EVIDENCE_ADMIN_MAX_BYTES;
  const seams: Required<EvidenceRouteSeams> = {
    async upload(context) {
      const { request } = context;
      try {
        return await files.ingest({ source: request, maxBytes: adminMaxBytes, declaredBytes: declaredLength(request), store: context.store,
          evidence: { eventId: context.eventId, matchId: context.matchId, source: 'web', submittedBy: 'local-admin',
            actor: context.actor, ...(context.note !== undefined ? { note: context.note } : {}) } });
      } catch (error) {
        throw uploadHttpError(error, request);
      }
    },
    async playback(context) {
      return tickets.issue(context.record, context.sessionLive);
    },
    async media(context) {
      const target = tickets.resolve(context.ticket);
      if (!target?.storagePath) throw new HttpError(404, 'not_found', 'This playback link has expired. Open the evidence again.');
      let filePath: string;
      try { filePath = files.pathOf(target); } catch { throw new HttpError(404, 'not_found', 'Not found.'); }
      await serveEvidenceFile({ request: context.request, response: context.response, head: context.head,
        download: context.download, root: files.root, filePath, mime: target.mime });
    },
    async removeFile(record) {
      tickets.revoke(record.id);
      await files.removeFile(record);
    }
  };
  return { seams, files, tickets };
}
