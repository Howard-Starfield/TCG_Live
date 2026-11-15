// Route module "channels" (agent B): sticky message CRUD and channel controls (lock, slowmode, purge).
// Every mutation is audited; sticky changes notify the running Discord feature (area 'stickies').
import { ChannelType } from 'discord.js';
import { ADMIN_TOOLS_LIMITS as L, type ChannelPurgeRequestDto, type StickyMessageDto } from '@tcg-live/core';
import { readJsonBody } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { badRequest, onlyParams, UUID } from '../../ops/http.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { bool, exactObject, int, oneOf, reason, snowflake } from '../validate.js';
import { auditLockLedger, channelControlError, channelState, demoChannelGateway, liveChannelGateway, pgLockLedger, purgeChannel,
  setChannelLock, setChannelSlowmode, type ChannelGateway, type LockLedger } from './controls.js';
import { stickiesTicketsRuntime, type StickiesTicketsRuntime } from './runtime-status.js';
import { MemoryStickyStore, parseStickyRequest, pgStickyStore, type StickyStore } from './sticky-store.js';
import type { StickyListItemDto } from './types.js';

export function parseLockRequest(input: unknown) {
  const value = exactObject(input, ['channelId', 'locked', 'reason'], 'Lock request');
  return { channelId: snowflake(value.channelId, 'Channel'), locked: bool(value.locked, 'Locked'), reason: reason(value.reason) };
}
export function parseSlowmodeRequest(input: unknown) {
  const value = exactObject(input, ['channelId', 'seconds', 'reason'], 'Slowmode request');
  return { channelId: snowflake(value.channelId, 'Channel'), seconds: int(value.seconds, 0, L.slowmodeSecondsMax, 'Slowmode seconds'), reason: reason(value.reason) };
}
export function parsePurgeRequest(input: unknown): ChannelPurgeRequestDto {
  const mode = oneOf((input as { mode?: unknown } | null)?.mode, ['count', 'user'] as const, 'purge mode');
  if (mode === 'count') {
    const value = exactObject(input, ['channelId', 'mode', 'count', 'reason'], 'Purge request');
    return { channelId: snowflake(value.channelId, 'Channel'), mode, count: int(value.count, 1, L.purgeCountMax, 'Message count'), reason: reason(value.reason) };
  }
  const value = exactObject(input, ['channelId', 'mode', 'userId', 'count', 'reason'], 'Purge request');
  return { channelId: snowflake(value.channelId, 'Channel'), mode, userId: snowflake(value.userId, 'Member'),
    count: int(value.count, 1, L.purgeCountMax, 'Message count'), reason: reason(value.reason) };
}

export interface ChannelsModuleOptions {
  stickies?: StickyStore;
  ledger?: LockLedger;
  gateway?(deps: AdminToolsRouteDeps): Promise<ChannelGateway>;
  runtime?: StickiesTicketsRuntime;
}

const TEXT = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

export function channelsRouteModule(options: ChannelsModuleOptions = {}): AdminToolsRouteModule {
  return {
    name: 'channels',
    routes(deps) {
      const memory = deps.storage === 'memory';
      const stickies = options.stickies ?? (memory ? new MemoryStickyStore(deps.now) : pgStickyStore(deps.now));
      const ledger = options.ledger ?? (memory ? auditLockLedger(deps.audit) : pgLockLedger());
      const runtime = options.runtime ?? stickiesTicketsRuntime;
      const gateway = async (): Promise<ChannelGateway> => {
        if (options.gateway) return options.gateway(deps);
        if (deps.demo) return demoChannelGateway(deps.demo, deps.now);
        if (!deps.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
        return liveChannelGateway(await deps.discord.guild());
      };
      const discordCall = async <T>(run: () => Promise<T>): Promise<T> => {
        try { return await run(); } catch (error) { return deps.guarded(async () => channelControlError(error)); }
      };
      /** The bot's own messages are never purged (cards, panels, stickies). */
      const botIds = (): string[] => {
        const id = deps.discord?.botUserId() ?? deps.demo?.members.find(member => member.bot)?.id ?? null;
        return id ? [id] : [];
      };
      // Demo stickies start with one example.
      let seeded = !deps.demo;
      const seed = async () => {
        if (seeded || !deps.demo) return;
        seeded = true;
        const rules = deps.demo.channels.find(channel => channel.name === 'rules');
        if (rules && !(await stickies.list(deps.guildId())).length) await stickies.save(deps.guildId(), null, { channelId: rules.id, enabled: true,
          debounceMs: 15_000, content: null, embed: { title: 'How to report a match', description: 'Use the buttons on your match card. Call a judge if you disagree.',
            color: 0x3b82f6, url: null, imageUrl: null, thumbnailUrl: null, footer: null, fields: [] } }).catch(() => {});
      };
      const withStatus = (sticky: StickyMessageDto): StickyListItemDto => ({ ...sticky, status: deps.demo
        ? { state: sticky.enabled ? 'posted' : 'disabled', message: null, atMs: sticky.updatedAtMs }
        : sticky.enabled ? runtime.stickyStatus(sticky.id) : { state: 'disabled', message: null, atMs: sticky.updatedAtMs } });

      /** Text or announcement channel, not reserved by the tournament, not the ticket panel's channel. */
      const checkStickyChannel = async (channelId: string) => {
        if ((await deps.reservedChannelIds()).has(channelId))
          throw badRequest('Stickies cannot live in the tournament signup channel or a match room. Choose another channel.');
        const settings = await deps.currentSettings();
        if (settings.tickets.enabled && settings.tickets.supportChannelId === channelId)
          throw badRequest('The ticket panel is already kept at the bottom of that channel. Choose another channel.');
        if (deps.demo) {
          const channel = deps.demo.channels.find(item => item.id === channelId);
          if (!channel || (channel.type !== 'text' && channel.type !== 'announcement')) throw badRequest('Choose a text channel.');
          return;
        }
        if (!deps.discord) return;
        const guild = await deps.discord.guild();
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !TEXT.has(channel.type)) throw badRequest('Choose a text channel.');
      };
      const stickyId = (params: string[]) => {
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'That sticky message does not exist.');
        return id.toLowerCase();
      };
      const audited = (kind: 'sticky.saved' | 'sticky.deleted', sticky: StickyMessageDto, extra: Record<string, unknown> = {}) =>
        deps.recordAudit(kind, { stickyId: sticky.id, channelId: sticky.channelId, enabled: sticky.enabled, debounceMs: sticky.debounceMs,
          hasEmbed: sticky.embed !== null, ...extra });

      return [
        { pattern: /^\/api\/v1\/admin-tools\/stickies$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            onlyParams(query, []);
            await seed();
            const list = await deps.guarded(() => stickies.list(deps.guildId()));
            sendJson(response, 200, { stickies: list.map(withStatus) });
          } },
          POST: { access: 'server.manage', run: async ({ request, response }) => {
            const input = await deps.guarded(async () => parseStickyRequest(await readJsonBody(request)));
            await checkStickyChannel(input.channelId);
            const saved = await deps.guarded(() => stickies.save(deps.guildId(), null, input));
            await audited('sticky.saved', saved, { created: true });
            deps.notify('stickies', saved.id);
            sendJson(response, 201, withStatus(saved));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/stickies\/([^/]+)$/, methods: {
          PUT: { access: 'server.manage', run: async ({ request, response, params }) => {
            const id = stickyId(params);
            const input = await deps.guarded(async () => parseStickyRequest(await readJsonBody(request)));
            await checkStickyChannel(input.channelId);
            const before = await deps.guarded(() => stickies.get(deps.guildId(), id));
            const saved = await deps.guarded(() => stickies.save(deps.guildId(), id, input));
            await audited('sticky.saved', saved, { created: false, movedFrom: before && before.channelId !== saved.channelId ? before.channelId : null });
            runtime.setStickyStatus(saved.id, null);
            deps.notify('stickies', saved.id);
            sendJson(response, 200, withStatus(saved));
          } },
          DELETE: { access: 'server.manage', run: async ({ response, params }) => {
            const id = stickyId(params);
            const removed = await deps.guarded(() => stickies.delete(deps.guildId(), id));
            await audited('sticky.deleted', removed);
            runtime.setStickyStatus(removed.id, null);
            deps.notify('stickies', removed.id);
            sendJson(response, 200, { deleted: removed.id, channelId: removed.channelId, lastMessageId: removed.lastMessageId });
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/channels\/state\/([^/]+)$/, methods: {
          GET: { access: 'members.moderate', run: async ({ response, params }) => {
            const channelId = await deps.guarded(async () => snowflake(params[0], 'Channel'));
            const live = await gateway();
            sendJson(response, 200, await discordCall(() => channelState(live, channelId)));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/channels\/lock$/, methods: {
          POST: { access: 'members.moderate', run: async ({ request, response }) => {
            const input = await deps.guarded(async () => parseLockRequest(await readJsonBody(request)));
            const live = await gateway();
            // Locking denies @everyone Send Messages, which the bot inherits: the tournament channels would stop getting cards.
            if (input.locked && (await deps.reservedChannelIds()).has(input.channelId))
              throw badRequest('The tournament signup channel and match rooms cannot be locked: the bot would lose Send Messages there.');
            const result = await discordCall(() => setChannelLock(live, ledger, deps.guildId(), input.channelId, input.locked, input.reason));
            if (result.changed) await deps.recordAudit(input.locked ? 'channel.lock' : 'channel.unlock', result.payload);
            sendJson(response, 200, result.state);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/channels\/slowmode$/, methods: {
          POST: { access: 'members.moderate', run: async ({ request, response }) => {
            const input = await deps.guarded(async () => parseSlowmodeRequest(await readJsonBody(request)));
            const live = await gateway();
            const state = await discordCall(() => setChannelSlowmode(live, input.channelId, input.seconds, input.reason));
            await deps.recordAudit('channel.slowmode', { channelId: input.channelId, seconds: input.seconds, reason: input.reason });
            sendJson(response, 200, state);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/channels\/purge$/, methods: {
          POST: { access: 'members.moderate', run: async ({ request, response }) => {
            const input = await deps.guarded(async () => parsePurgeRequest(await readJsonBody(request)));
            const live = await gateway();
            const result = await discordCall(() => purgeChannel(live, input, deps.now(), botIds()));
            await deps.recordAudit('channel.purge', { channelId: input.channelId, mode: input.mode, count: input.count,
              ...(input.mode === 'user' ? { userId: input.userId } : {}), deleted: result.deleted, skippedTooOld: result.skippedTooOld, reason: input.reason });
            sendJson(response, 200, result);
          } }
        } }
      ];
    }
  };
}
