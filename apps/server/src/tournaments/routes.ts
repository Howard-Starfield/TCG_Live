import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArtworkGame, OpenTournamentSignupResult, TournamentSignupChannelDto } from '@tcg-live/core';
import type { ArtworkApplyResult } from '../artwork/routes.js';
import { readJsonBody, strictObject } from '../admin/http/body.js';
import { RuleError } from '../rehearsal/domain.js';
import { ControllerUnavailableError } from '../discord/controller.js';
import { HttpError, sendJson } from '../admin/http/respond.js';
import { DirectoryConflictError, DirectoryInputError, DirectoryUnavailableError,
  type TournamentDirectory } from './directory.js';

type Context = { request: IncomingMessage; response: ServerResponse; query: URLSearchParams; params: string[] };
type Endpoint = { access: 'session'; run(context: Context): Promise<void> };
export type TournamentRoute = { pattern: RegExp; methods: Partial<Record<string, Endpoint>> };

function fail(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof DirectoryInputError) throw new HttpError(400, 'bad_request', error.message);
  if (error instanceof DirectoryConflictError) throw new HttpError(409, 'conflict', error.message);
  if (error instanceof DirectoryUnavailableError) throw new HttpError(503, 'unavailable', error.message);
  throw new HttpError(503, 'unavailable', 'Tournament directory is unavailable. Check PostgreSQL and run npm run db:directory-setup -w @tcg-live/server.');
}

export function tournamentRoutes(directory: TournamentDirectory, defaultGame: () => ArtworkGame,
  apply?: (game: ArtworkGame) => Promise<ArtworkApplyResult>,
  openSignup?: (eventId: string, expectedActiveEventId: string | null) => Promise<OpenTournamentSignupResult>,
  signupChannels?: () => Promise<TournamentSignupChannelDto[]>,
  deleteTournament?: (eventId: string) => Promise<{ cleanupPending: boolean }>): TournamentRoute[] {
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  return [
    { pattern: /^\/api\/v1\/tournaments\/signup-channels$/, methods: {
      GET: { access: 'session', run: async ({ response }) => {
        if (!signupChannels) throw new HttpError(503, 'unavailable', 'Discord channel discovery is unavailable.');
        try { sendJson(response, 200, await signupChannels()); }
        catch { throw new HttpError(503, 'unavailable', 'Discord channels could not be loaded. Retry when the bot is online.'); }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments\/([0-9a-f-]+)\/open-signup$/i, methods: {
      POST: { access: 'session', run: async ({ request, response, params }) => {
        if (!openSignup) throw new HttpError(403, 'forbidden', 'Tournament commands are disabled for this console.');
        const eventId = params[0]!;
        const { expectedActiveEventId } = strictObject(await readJsonBody(request), ['expectedActiveEventId']);
        if (!uuid.test(eventId) || (expectedActiveEventId !== null &&
            (typeof expectedActiveEventId !== 'string' || !uuid.test(expectedActiveEventId))))
          throw new HttpError(400, 'bad_request', 'Select a valid draft and confirm the active tournament.');
        try { sendJson(response, 200, await openSignup(eventId.toLowerCase(), expectedActiveEventId?.toLowerCase() ?? null)); }
        catch (error) {
          if (error instanceof ControllerUnavailableError) throw new HttpError(503, 'unavailable', error.message);
          if (error instanceof RuleError) throw new HttpError(409, 'conflict', error.message);
          fail(error);
        }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments\/([0-9a-f-]+)$/i, methods: {
      DELETE: { access: 'session', run: async ({ response, params }) => {
        if (!deleteTournament) throw new HttpError(403, 'forbidden', 'Tournament commands are disabled for this console.');
        const eventId = params[0]!;
        if (!uuid.test(eventId)) throw new HttpError(400, 'bad_request', 'Select a valid tournament.');
        try { sendJson(response, 200, await deleteTournament(eventId.toLowerCase())); }
        catch (error) {
          if (error instanceof ControllerUnavailableError) throw new HttpError(503, 'unavailable', error.message);
          if (error instanceof RuleError) throw new HttpError(409, 'conflict', error.message);
          fail(error);
        }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments\/([0-9a-f-]+)\/details$/i, methods: {
      GET: { access: 'session', run: async ({ response, params }) => {
        try {
          if (!directory.getDetails) throw new DirectoryUnavailableError('Tournament details are unavailable.');
          sendJson(response, 200, await directory.getDetails(params[0]!.toLowerCase()));
        } catch (error) { fail(error); }
      } },
      PUT: { access: 'session', run: async ({ request, response, params }) => {
        try {
          if (!directory.saveDetails) throw new DirectoryUnavailableError('Tournament details are unavailable.');
          const saved = await directory.saveDetails(params[0]!.toLowerCase(), await readJsonBody(request));
          let result: ArtworkApplyResult = { status: 'pending', message: 'Discord panel update is unavailable.' };
          try { if (apply && saved.game) result = await apply(saved.game); }
          catch { result = { status: 'pending', message: 'Saved; Discord panel update could not be completed.' }; }
          sendJson(response, 200, { ...saved, applyStatus: result.status, ...(result.message ? { applyMessage: result.message } : {}) });
        } catch (error) { fail(error); }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments$/, methods: {
      GET: { access: 'session', run: async ({ response, query }) => {
        if ([...query.keys()].some(key => key !== 'q') || query.getAll('q').length > 1)
          throw new HttpError(400, 'bad_request', 'Use one q search parameter.');
        try { sendJson(response, 200, await directory.list(query.get('q') ?? '', defaultGame())); }
        catch (error) { fail(error); }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments\/drafts\/([0-9a-f-]+)$/i, methods: {
      DELETE: { access: 'session', run: async ({ response, params }) => {
        if (!directory.deleteDraft || !openSignup) throw new HttpError(403, 'forbidden', 'Tournament commands are disabled for this console.');
        try {
          await directory.deleteDraft(params[0]!.toLowerCase());
          sendJson(response, 200, { deleted: true });
        } catch (error) { fail(error); }
      } }
    } },
    { pattern: /^\/api\/v1\/tournaments\/drafts$/, methods: {
      POST: { access: 'session', run: async ({ request, response }) => {
        try { sendJson(response, 200, await directory.createDraft(await readJsonBody(request))); }
        catch (error) { fail(error); }
      } }
    } }
  ];
}
