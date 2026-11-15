// (D) HTTP routes: the log list with filters and paging, message-store stats for the privacy notice, and the
// audited "Delete stored message history" action. Logging settings are saved through the foundation's
// PUT /api/v1/admin-tools/settings (section 'logging').
import { MEMBER_LOG_KINDS, MESSAGE_LOG_KINDS, ADMIN_TOOLS_LIMITS as L } from '@tcg-live/core';
import { sendJson } from '../../admin/http/respond.js';
import { badRequest, integerQuery, onlyParams, SNOWFLAKE } from '../../ops/http.js';
import type { AdminToolsRouteModule } from '../module.js';
import { seedDemoLogs } from './demo.js';
import { MemoryLoggingStore, pgLoggingStore, type LoggingStore } from './store.js';
import type { LogKind, LogQuery } from './types.js';

const PARAMS = ['stream', 'order', 'after', 'before', 'limit', 'userId', 'kind', 'channelId', 'fromMs', 'toMs'] as const;
const MS_MAX = 8_640_000_000_000;

export function parseLogQuery(query: URLSearchParams): LogQuery {
  onlyParams(query, PARAMS);
  const stream = query.get('stream') ?? 'member';
  if (stream !== 'member' && stream !== 'message') throw badRequest('stream must be member or message.');
  const order = query.get('order') ?? 'oldest';
  if (order !== 'oldest' && order !== 'newest') throw badRequest('order must be oldest or newest.');
  const kinds: readonly string[] = stream === 'member' ? MEMBER_LOG_KINDS : MESSAGE_LOG_KINDS;
  const kind = query.get('kind');
  if (kind !== null && !kinds.includes(kind)) throw badRequest(`kind must be one of ${kinds.join(', ')}.`);
  const id = (name: string) => {
    const value = query.get(name);
    if (value !== null && !SNOWFLAKE.test(value)) throw badRequest(`${name} must be a Discord ID.`);
    return value;
  };
  const channelId = id('channelId');
  if (channelId && stream !== 'message') throw badRequest('channelId filters the message log only.');
  const time = (name: string) => query.has(name) ? integerQuery(query, name, 0, 0, MS_MAX) : null;
  const fromMs = time('fromMs'), toMs = time('toMs');
  if (fromMs !== null && toMs !== null && fromMs > toMs) throw badRequest('fromMs must not be after toMs.');
  return { stream, order, kind: kind as LogKind | null, channelId, fromMs, toMs, userId: id('userId'),
    after: integerQuery(query, 'after', 0, 0, Number.MAX_SAFE_INTEGER),
    before: integerQuery(query, 'before', 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integerQuery(query, 'limit', 50, 1, L.logPageLimit) };
}

export function loggingRouteModule(storeFor?: (storage: 'postgres' | 'memory') => LoggingStore): AdminToolsRouteModule {
  return {
    name: 'logging',
    routes(deps) {
      let store: LoggingStore;
      if (storeFor) store = storeFor(deps.storage);
      else if (deps.storage === 'postgres') store = pgLoggingStore();
      else {
        const memory = new MemoryLoggingStore();
        if (deps.demo) seedDemoLogs(memory, deps.demo, deps.now());
        store = memory;
      }
      return [
        { pattern: /^\/api\/v1\/admin-tools\/logs$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            const guildId = deps.guildId();
            const parsed = parseLogQuery(query);
            sendJson(response, 200, await deps.guarded(() => store.list(guildId, parsed)));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/logs\/message-store$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            onlyParams(query, []);
            const guildId = deps.guildId();
            sendJson(response, 200, await deps.guarded(() => store.messageStats(guildId)));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/logs\/messages$/, methods: {
          DELETE: { access: 'server.manage', run: async ({ response, query }) => {
            onlyParams(query, []);
            const guildId = deps.guildId();
            const result = await deps.guarded(() => store.deleteMessageHistory(guildId));
            await deps.recordAudit('logging.retention', { reason: 'manual', ...result });
            deps.notify('logging', null);
            sendJson(response, 200, result);
          } }
        } }
      ];
    }
  };
}
