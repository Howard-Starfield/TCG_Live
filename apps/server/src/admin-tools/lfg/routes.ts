// Route module "lfg": versioned LFG settings, the post list with filters, close/delete, stats and panel status.
// Every mutation is audited; changes notify the running Discord feature (area 'lfg').
import { ChannelType } from 'discord.js';
import { LFG_POST_STATUSES, type LfgPanelListDto, type LfgPostListDto, type LfgSettingsConflictDto, type LfgSettingsDto } from '@tcg-live/core';
import { readJsonBody, strictObject } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { badRequest, integerQuery, onlyParams, UUID } from '../../ops/http.js';
import { MemoryStickyStore, pgStickyStore, type StickyStore } from '../channels/sticky-store.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { seedLfgDemo } from './demo.js';
import { liveLfgGateway, MemoryLfgGateway } from './gateway.js';
import { lfgRuntime, type LfgRuntime } from './runtime.js';
import { endLfgPost, type LfgGateway, type LfgServiceDeps } from './service.js';
import { lfgBody, lfgChannelProblem, LfgVersionConflictError, MemoryLfgSettingsStore, parseLfgSettings, pgLfgSettingsStore,
  type LfgSettingsStore } from './settings.js';
import { LFG_PAGE_LIMIT, MemoryLfgPostStore, pgLfgPostStore, type LfgPostStore } from './store.js';

export interface LfgModuleOptions {
  settings?: LfgSettingsStore;
  posts?: LfgPostStore;
  stickies?: StickyStore;
  gateway?: LfgGateway;
  runtime?: LfgRuntime;
  /** Seed demo data (default: only with the demo guild and no injected stores). */
  seedDemo?: boolean;
}

const DAY = 86_400_000;

export function lfgRouteModule(options: LfgModuleOptions = {}): AdminToolsRouteModule {
  return {
    name: 'lfg',
    routes(deps: AdminToolsRouteDeps) {
      const memory = deps.storage === 'memory';
      const settingsStore = options.settings ?? (memory ? new MemoryLfgSettingsStore(deps.audit, deps.now) : pgLfgSettingsStore(deps.now));
      const posts = options.posts ?? (memory ? new MemoryLfgPostStore() : pgLfgPostStore());
      const stickies = options.stickies ?? (memory ? new MemoryStickyStore(deps.now) : pgStickyStore(deps.now));
      const runtime = options.runtime ?? lfgRuntime;
      const demoGateway = deps.demo ? new MemoryLfgGateway() : null;
      const gateway = async (): Promise<LfgGateway> => {
        if (options.gateway) return options.gateway;
        if (demoGateway) return demoGateway;
        if (!deps.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
        return liveLfgGateway(await deps.discord.guild());
      };
      const service = async (): Promise<LfgServiceDeps> => ({ guildId: deps.guildId(), store: posts, gateway: await gateway(), now: deps.now,
        settings: async () => lfgBody(await settingsStore.get(deps.guildId())),
        audit: (kind, payload, actor) => deps.recordAudit(kind, payload, actor) });
      let seeded = !(options.seedDemo ?? (!!deps.demo && !options.settings && !options.posts));
      const seed = async () => {
        if (seeded) return;
        seeded = true;
        await seedLfgDemo({ deps, settings: settingsStore, posts, gateway: demoGateway ?? new MemoryLfgGateway() }).catch(() => {});
      };
      const postId = (params: string[]) => {
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'That LFG post does not exist.');
        return id.toLowerCase();
      };
      const voiceChannels = async (): Promise<Set<string>> => {
        if (deps.demo) return new Set(deps.demo.channels.filter(channel => channel.type === 'voice').map(channel => channel.id));
        if (!deps.discord) return new Set();
        try {
          const channels = await (await deps.discord.guild()).channels.fetch();
          return new Set([...channels.values()].filter(channel => channel && (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice))
            .map(channel => channel!.id));
        } catch { throw new HttpError(503, 'unavailable', 'Discord did not answer. Try again in a moment.'); }
      };

      return [
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/settings$/, methods: {
          GET: { access: 'members.read', run: async ({ response }) => {
            await seed();
            sendJson(response, 200, await deps.guarded(() => settingsStore.get(deps.guildId())));
          } },
          PUT: { access: 'server.manage', run: async ({ request, response }) => {
            const id = deps.guildId();
            const { expectedVersion, settings } = strictObject(await readJsonBody(request), ['expectedVersion', 'settings']);
            if (typeof expectedVersion !== 'number') throw badRequest('expectedVersion must be the version you loaded.');
            const parsed = await deps.guarded(async () => parseLfgSettings(settings));
            const admin = await deps.currentSettings();
            const clash = lfgChannelProblem(parsed, { reserved: await deps.reservedChannelIds(), voice: await voiceChannels(),
              stickies: new Set((await deps.guarded(() => stickies.list(id))).filter(item => item.enabled).map(item => item.channelId)),
              ticketPanel: admin.tickets.enabled ? admin.tickets.supportChannelId : null });
            if (clash) throw badRequest(clash);
            let saved: LfgSettingsDto;
            try { saved = await settingsStore.put(id, expectedVersion, settings, LOCAL_ADMIN); }
            catch (error) {
              if (error instanceof LfgVersionConflictError) {
                const body: LfgSettingsConflictDto = { error: { code: 'conflict', message: error.message }, current: error.current };
                sendJson(response, 409, body);
                return;
              }
              return deps.guarded(async () => { throw error; });
            }
            deps.notify('lfg');
            sendJson(response, 200, saved);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/posts$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            onlyParams(query, ['status', 'game', 'limit']);
            const status = query.get('status');
            if (status !== null && status !== 'active' && !(LFG_POST_STATUSES as readonly string[]).includes(status)) throw badRequest('Choose a valid post status.');
            const game = query.get('game');
            if (game !== null && (!game.trim() || game.length > 60)) throw badRequest('Choose a valid game.');
            const limit = integerQuery(query, 'limit', 50, 1, LFG_PAGE_LIMIT);
            await seed();
            const body: LfgPostListDto = { posts: await deps.guarded(() => posts.list(deps.guildId(),
              { status: status as LfgPostListDto['posts'][number]['status'] | 'active' | null, game, limit })) };
            sendJson(response, 200, body);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/posts\/([^/]+)\/close$/, methods: {
          POST: { access: 'members.moderate', run: async ({ response, params }) => {
            const id = postId(params);
            const context = await service();
            const closed = await deps.guarded(() => endLfgPost(context, id, 'closed', 'dashboard', LOCAL_ADMIN));
            if (!closed) {
              const current = await deps.guarded(() => posts.get(deps.guildId(), id));
              if (!current) throw new HttpError(404, 'not_found', 'That LFG post does not exist.');
              throw new HttpError(409, 'conflict', 'That post is already closed.');
            }
            deps.notify('lfg', id);
            sendJson(response, 200, closed);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/posts\/([^/]+)$/, methods: {
          DELETE: { access: 'members.moderate', run: async ({ response, params }) => {
            const id = postId(params);
            const context = await service();
            const deleted = await deps.guarded(() => endLfgPost(context, id, 'deleted', 'dashboard', LOCAL_ADMIN));
            if (!deleted) {
              const current = await deps.guarded(() => posts.get(deps.guildId(), id));
              if (!current) throw new HttpError(404, 'not_found', 'That LFG post does not exist.');
              throw new HttpError(409, 'conflict', 'That post is already deleted.');
            }
            deps.notify('lfg', id);
            sendJson(response, 200, deleted);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/stats$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            onlyParams(query, ['days']);
            const days = integerQuery(query, 'days', 30, 1, 365);
            await seed();
            sendJson(response, 200, await deps.guarded(() => posts.stats(deps.guildId(), deps.now() - days * DAY)));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/panels$/, methods: {
          GET: { access: 'members.read', run: async ({ response }) => {
            await seed();
            const settings = await deps.guarded(() => settingsStore.get(deps.guildId()));
            const body: LfgPanelListDto = { panels: deps.demo
              ? settings.channels.map(channel => ({ channelId: channel.channelId, state: settings.enabled ? 'posted' : 'disabled', message: null, atMs: deps.now() }))
              : settings.channels.map(channel => runtime.panelStatuses().find(item => item.channelId === channel.channelId)
                ?? { channelId: channel.channelId, state: settings.enabled ? 'waiting' : 'disabled', message: null, atMs: deps.now() }) };
            sendJson(response, 200, body);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/lfg\/panels\/refresh$/, methods: {
          POST: { access: 'server.manage', run: async ({ response }) => {
            const settings = await deps.guarded(() => settingsStore.get(deps.guildId()));
            if (!settings.enabled || !settings.channels.length) throw badRequest('Turn LFG on and choose a channel, then save, before posting the panels.');
            let panels: LfgPanelListDto['panels'] = settings.channels.map(channel => ({ channelId: channel.channelId, state: 'posted', message: null, atMs: deps.now() }));
            if (!deps.demo) {
              const refresh = runtime.panelRefresher();
              if (!refresh) throw new HttpError(503, 'unavailable', 'The bot is not running. Start it, then try again.');
              panels = await refresh();
            }
            await deps.recordAudit('lfg.panel', { action: 'refreshed', channels: panels.map(panel => ({ channelId: panel.channelId, state: panel.state })) });
            sendJson(response, 200, { panels } satisfies LfgPanelListDto);
          } }
        } }
      ];
    }
  };
}
