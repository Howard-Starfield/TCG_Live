// Moderation HTTP routes: settings, flags, helper voice bots and the ops audit. AutoMod sync is a typed
// seam (ModerationRouteOptions.automodSync) that answers 501 until provided.
import type { AutoModSyncResultDto, ModerationFlagPageDto, ModerationSettingsConflictDto, ModerationSettingsDto,
  OpsAuditPageDto, VoiceBotPoolDto } from '@tcg-live/core';
import { MODERATION_FLAG_PAGE_LIMIT, OPS_AUDIT_PAGE_LIMIT } from '@tcg-live/core';
import { readEmptyBody, readJsonBody, strictObject } from '../admin/http/body.js';
import { HttpError, sendJson } from '../admin/http/respond.js';
import { LOCAL_ADMIN, type OpsAuditStore } from '../ops/audit.js';
import { mapOpsError } from '../ops/errors.js';
import { badRequest, integerQuery, notImplemented, onlyParams, UUID, type OpsRoute } from '../ops/http.js';
import { describeVoicePool, type VoicePoolStatusSource } from '../voice/pool.js';
import { tokenUserId, validateBotToken, type VoiceBotRegistry } from '../voice/tokens.js';
import type { ModerationFlagStore } from './flags.js';
import { validateAutoModText } from './automod.js';
import { ModerationVersionConflictError, parseModerationSettings, type ModerationSettingsStore } from './settings.js';

export const MODERATION_UNAVAILABLE = 'Moderation storage is unavailable. Check PostgreSQL and run npm run db:evidence-setup -w @tcg-live/server.';

export interface ModerationRouteOptions {
  settings: ModerationSettingsStore;
  flags: ModerationFlagStore;
  audit: OpsAuditStore;
  voiceBots: VoiceBotRegistry;
  /** The configured Discord server; null answers 503 until setup finishes. */
  guildId(): string | null;
  /** The main bot's Discord user ID, when connected. */
  mainBotUserId?(): string | null;
  /** Live voice pool state from the voice runtime (later phase). */
  voicePool?: VoicePoolStatusSource;
  /** POST /api/v1/moderation/automod/sync (later phase). The route audits automod.synced on success. */
  automodSync?(guildId: string, settings: ModerationSettingsDto): Promise<AutoModSyncResultDto>;
  /** After a committed settings save; running Discord features reload from here. Never throws into the route. */
  onSettingsSaved?(settings: ModerationSettingsDto): void;
  /** After a helper bot is added or removed; the voice runtime reloads its pool from here. */
  onVoiceBotsChanged?(): void;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { return mapOpsError(error, MODERATION_UNAVAILABLE); }
}

export function moderationRoutes(options: ModerationRouteOptions): OpsRoute[] {
  const guild = (): string => {
    const id = options.guildId();
    if (!id) throw new HttpError(503, 'unavailable', 'Finish Discord setup before changing moderation settings.');
    return id;
  };
  const pool = async (): Promise<VoiceBotPoolDto> => describeVoicePool(await guarded(() => options.voiceBots.list()),
    options.voicePool?.live() ?? null, { userId: options.mainBotUserId?.() ?? null });
  const notify = (callback: (() => void) | undefined) => { try { callback?.(); } catch { /* Listeners never fail a save. */ } };
  return [
    { pattern: /^\/api\/v1\/moderation\/settings$/, methods: {
      GET: { access: 'moderation.manage', run: async ({ response }) => {
        const id = guild();
        sendJson(response, 200, await guarded(() => options.settings.get(id)));
      } },
      PUT: { access: 'moderation.manage', run: async ({ request, response }) => {
        const id = guild();
        const { expectedVersion, settings } = strictObject(await readJsonBody(request), ['expectedVersion', 'settings']);
        if (typeof expectedVersion !== 'number') throw badRequest('expectedVersion must be the version you loaded.');
        // Refuse settings Discord AutoMod would reject (for example Flag only without an alert channel).
        await guarded(async () => validateAutoModText(parseModerationSettings(settings).text));
        let saved: ModerationSettingsDto;
        try { saved = await options.settings.put(id, expectedVersion, settings, LOCAL_ADMIN); }
        catch (error) {
          if (error instanceof ModerationVersionConflictError) {
            const body: ModerationSettingsConflictDto = { error: { code: 'conflict', message: error.message }, current: error.current };
            sendJson(response, 409, body);
            return;
          }
          return mapOpsError(error, MODERATION_UNAVAILABLE);
        }
        notify(options.onSettingsSaved && (() => options.onSettingsSaved!(saved)));
        sendJson(response, 200, saved);
      } }
    } },
    { pattern: /^\/api\/v1\/moderation\/flags$/, methods: {
      GET: { access: 'moderation.manage', run: async ({ response, query }) => {
        onlyParams(query, ['after', 'limit', 'eventId', 'matchId']);
        const after = integerQuery(query, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = integerQuery(query, 'limit', 100, 1, MODERATION_FLAG_PAGE_LIMIT);
        const eventId = query.get('eventId');
        const matchId = query.get('matchId');
        if (eventId !== null && !UUID.test(eventId)) throw badRequest('Invalid event ID.');
        if (matchId !== null && !/^M[1-9]\d{0,3}$/.test(matchId)) throw badRequest('Invalid match ID.');
        const id = guild();
        const page: ModerationFlagPageDto = await guarded(() => options.flags.list(id, { after, limit, eventId, matchId }));
        sendJson(response, 200, page);
      } }
    } },
    { pattern: /^\/api\/v1\/moderation\/voice-bots$/, methods: {
      GET: { access: 'moderation.manage', run: async ({ response }) => sendJson(response, 200, await pool()) },
      POST: { access: 'moderation.manage', run: async ({ request, response }) => {
        const { label, token } = strictObject(await readJsonBody(request), ['label', 'token']);
        // The main bot's own token as a helper would open a second voice connection for the same user and
        // pull the main bot out of its room; refuse it (the message never echoes the token).
        const main = options.mainBotUserId?.() ?? null;
        if (main !== null && typeof token === 'string') {
          let helperUser: string | null = null;
          try { helperUser = tokenUserId(validateBotToken(token)); } catch { /* add() reports the shape error. */ }
          if (helperUser === main) throw new HttpError(409, 'conflict', "That is the main bot's token. Add a separate helper application instead.");
        }
        const bot = await guarded(() => options.voiceBots.add(label, token));
        try {
          await options.audit.append({ kind: 'moderation.voice_bot.added', actor: LOCAL_ADMIN, guildId: options.guildId(),
            payload: { botId: bot.id, label: bot.label, userId: bot.userId } });
        } catch (error) {
          // Every pool change is audited: undo the add when the audit cannot be written.
          await options.voiceBots.remove(bot.id).catch(() => {});
          return mapOpsError(error, MODERATION_UNAVAILABLE);
        }
        notify(options.onVoiceBotsChanged);
        sendJson(response, 201, await pool());
      } }
    } },
    { pattern: /^\/api\/v1\/moderation\/voice-bots\/([^/]+)$/, methods: {
      DELETE: { access: 'moderation.manage', run: async ({ request, response, params }) => {
        await readEmptyBody(request);
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'Helper bot not found.');
        const bot = (await guarded(() => options.voiceBots.list())).find(item => item.id === id.toLowerCase());
        if (!bot) throw new HttpError(404, 'not_found', 'Helper bot not found.');
        // Audit first: a removal that cannot be audited does not happen.
        await guarded(() => options.audit.append({ kind: 'moderation.voice_bot.removed', actor: LOCAL_ADMIN, guildId: options.guildId(),
          payload: { botId: bot.id, label: bot.label, userId: bot.userId } }));
        await guarded(() => options.voiceBots.remove(bot.id));
        notify(options.onVoiceBotsChanged);
        sendJson(response, 200, await pool());
      } }
    } },
    { pattern: /^\/api\/v1\/moderation\/automod\/sync$/, methods: {
      POST: { access: 'moderation.manage', run: async ({ request, response }) => {
        await readEmptyBody(request);
        if (!options.automodSync) throw notImplemented('Discord AutoMod sync');
        const sync = options.automodSync;
        const id = guild();
        const settings = await guarded(() => options.settings.get(id));
        const result = await guarded(() => sync(id, settings));
        await guarded(() => options.audit.append({ kind: 'automod.synced', actor: LOCAL_ADMIN, guildId: id,
          payload: { status: result.status, ruleIds: result.ruleIds, presetManagedElsewhere: result.presetManagedElsewhere } }));
        sendJson(response, 200, result);
      } }
    } },
    { pattern: /^\/api\/v1\/ops\/audit$/, methods: {
      GET: { access: 'evidence.read', run: async ({ response, query }) => {
        onlyParams(query, ['after', 'limit', 'eventId']);
        const after = integerQuery(query, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = integerQuery(query, 'limit', 200, 1, OPS_AUDIT_PAGE_LIMIT);
        const eventId = query.get('eventId');
        if (eventId !== null && !UUID.test(eventId)) throw badRequest('Invalid event ID.');
        const page: OpsAuditPageDto = await guarded(() => options.audit.list({ after, limit, eventId }));
        sendJson(response, 200, page);
      } }
    } }
  ];
}
