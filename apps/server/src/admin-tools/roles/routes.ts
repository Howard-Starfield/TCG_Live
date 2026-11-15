// Admin tools routes for button-role panels and bulk role jobs (agent C):
//   GET/POST /api/v1/admin-tools/button-roles, PUT/DELETE /button-roles/:id, POST /button-roles/:id/publish
//   GET/POST /api/v1/admin-tools/bulk-roles, POST /bulk-roles/preview, GET /bulk-roles/:id, POST /bulk-roles/:id/cancel
import { randomUUID } from 'node:crypto';
import { readJsonBody } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { badRequest, onlyParams, type OpsRoute } from '../../ops/http.js';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { BulkRoleRunner, jobDetail, jobDto, MemoryBulkRoleJobStore, parseBulkRequest, pgBulkRoleJobStore, resolveBulkTargets,
  type BulkRoleJobStore, type StoredBulkJob } from './bulk.js';
import type { RolesGuildPort } from './guild-port.js';
import { MemoryButtonRolePanelStore, panelView, panelWarnings, parsePanelInput, pgButtonRolePanelStore, roleWarning,
  type ButtonRolePanelStore, type StoredPanel } from './panels.js';
import { discordCall, routePort } from './port.js';
import { panelMessage } from './render.js';
import type { BulkRolePreviewDto, ButtonRolePanelListDto, RoleWarningDto } from './types.js';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
export const BULK_JOB_LIST_LIMIT = 50;

export interface RolesRouteStores { panels: ButtonRolePanelStore; jobs: BulkRoleJobStore }

/** Tests pass stores and runner pacing; the registry uses the defaults. */
export function rolesRouteModule(overrides: { stores?: RolesRouteStores; runner?: { pauseMs?: number; sleep?(ms: number): Promise<void> } } = {}): AdminToolsRouteModule {
  return { name: 'roles', routes: deps => rolesRoutes(deps, overrides) };
}

function rolesRoutes(deps: AdminToolsRouteDeps, overrides: Parameters<typeof rolesRouteModule>[0] = {}): OpsRoute[] {
  const stores: RolesRouteStores = overrides.stores ?? (deps.storage === 'postgres'
    ? { panels: pgButtonRolePanelStore(), jobs: pgBulkRoleJobStore() }
    : { panels: new MemoryButtonRolePanelStore(), jobs: new MemoryBulkRoleJobStore() });
  const port = routePort(deps);
  const g = deps.guarded;
  // The demo has no Discord feature runtime: run jobs right here against the synthetic server.
  let demoRunner: BulkRoleRunner | null = null;
  const runner = () => demoRunner ??= new BulkRoleRunner({ store: stores.jobs, guildId: deps.guildId(), port, now: deps.now,
    ...(overrides.runner?.pauseMs !== undefined ? { pauseMs: overrides.runner.pauseMs } : {}),
    ...(overrides.runner?.sleep ? { sleep: overrides.runner.sleep } : {}),
    audit: (kind, payload) => deps.recordAudit(kind, payload, { kind: 'bot', id: 'bot' }) });

  const findPanel = async (id: string) => {
    const panel = await g(() => stores.panels.get(deps.guildId(), id));
    if (!panel) throw new HttpError(404, 'not_found', 'That panel no longer exists.');
    return panel;
  };
  const warningsFor = async (panels: readonly StoredPanel[]): Promise<Map<string, RoleWarningDto[]>> => {
    const result = new Map<string, RoleWarningDto[]>();
    try {
      const { roles, botTopPosition } = await (await port()).roles();
      for (const panel of panels) result.set(panel.id, panelWarnings(panel, roles, botTopPosition, deps.guildId()));
    } catch { /* Discord offline: no warnings rather than an error. */ }
    return result;
  };
  const view = async (panel: StoredPanel) => panelView(panel, (await warningsFor([panel])).get(panel.id) ?? []);

  /** Posts or edits the panel's message. An edit of a deleted message marks it missing (no silent repost). */
  const sync = async (panel: StoredPanel, repost: boolean): Promise<StoredPanel> => {
    const guild = await port();
    const message = panelMessage(panel);
    let next = { ...panel };
    if (panel.messageId && !panel.messageMissing) {
      const outcome = await discordCall(() => guild.edit(panel.channelId, panel.messageId!, message));
      if (outcome === 'missing') next = { ...next, messageMissing: true };
    }
    if (repost && (!next.messageId || next.messageMissing)) {
      const messageId = await discordCall(() => guild.send(panel.channelId, message));
      next = { ...next, messageId, messageMissing: false };
    }
    return next;
  };

  const panelRoutes: OpsRoute[] = [
    { pattern: /^\/api\/v1\/admin-tools\/button-roles$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        let panels = await g(() => stores.panels.list(deps.guildId()));
        // Notice panels whose message was deleted in Discord (status + Repost in the dashboard).
        let guild: RolesGuildPort | null = null;
        try { guild = await port(); } catch { guild = null; }
        if (guild) {
          panels = await Promise.all(panels.map(async panel => {
            if (!panel.messageId || panel.messageMissing) return panel;
            const exists = await guild!.exists(panel.channelId, panel.messageId).catch(() => true);
            return exists ? panel : g(() => stores.panels.update({ ...panel, messageMissing: true }));
          }));
        }
        const warnings = await warningsFor(panels);
        const body: ButtonRolePanelListDto = { panels: panels.map(panel => panelView(panel, warnings.get(panel.id) ?? [])) };
        sendJson(response, 200, body);
      } },
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const input = await g(async () => parsePanelInput(await readJsonBody(request), deps.guildId()));
        const panel: StoredPanel = { id: randomUUID(), guildId: deps.guildId(), messageId: null, messageMissing: false,
          updatedAtMs: deps.now(), ...input };
        await g(() => stores.panels.create(panel));
        await deps.recordAudit('button_roles.saved', { panelId: panel.id, channelId: panel.channelId, buttons: panel.buttons.length, created: true });
        deps.notify('roles', panel.id);
        sendJson(response, 201, await view(panel));
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/button-roles/${ID}$`), methods: {
      PUT: { access: 'server.manage', run: async ({ request, response, params }) => {
        const current = await findPanel(params[0]!);
        const input = await g(async () => parsePanelInput(await readJsonBody(request), deps.guildId()));
        let next: StoredPanel = { ...current, ...input, updatedAtMs: deps.now() };
        if (current.messageId && !current.messageMissing && current.channelId !== input.channelId) {
          // Moved: remove the old message, post in the new channel.
          await discordCall(async () => (await port()).remove(current.channelId, current.messageId!));
          next = await sync({ ...next, messageId: null }, true);
        } else if (current.messageId && !current.messageMissing) next = await sync(next, false);
        await g(() => stores.panels.update(next));
        await deps.recordAudit('button_roles.saved', { panelId: next.id, channelId: next.channelId, buttons: next.buttons.length,
          messageUpdated: !!next.messageId && !next.messageMissing });
        deps.notify('roles', next.id);
        sendJson(response, 200, await view(next));
      } },
      DELETE: { access: 'server.manage', run: async ({ response, params }) => {
        const panel = await findPanel(params[0]!);
        if (panel.messageId && !panel.messageMissing) await discordCall(async () => (await port()).remove(panel.channelId, panel.messageId!));
        await g(() => stores.panels.delete(deps.guildId(), panel.id));
        await deps.recordAudit('button_roles.deleted', { panelId: panel.id, channelId: panel.channelId });
        deps.notify('roles', panel.id);
        sendJson(response, 200, { deleted: true });
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/button-roles/${ID}/publish$`), methods: {
      POST: { access: 'server.manage', run: async ({ response, params }) => {
        const panel = await findPanel(params[0]!);
        const next = { ...(await sync(panel, true)), updatedAtMs: deps.now() };
        await g(() => stores.panels.update(next));
        await deps.recordAudit('button_roles.published', { panelId: next.id, channelId: next.channelId, messageId: next.messageId,
          reposted: panel.messageMissing || !panel.messageId });
        deps.notify('roles', next.id);
        sendJson(response, 200, await view(next));
      } }
    } }
  ];

  const resolve = async (input: ReturnType<typeof parseBulkRequest>) => {
    const userIds = await resolveBulkTargets(input.target, deps.tournamentMembers);
    if (!userIds) throw badRequest('That tournament was not found.');
    let warning: RoleWarningDto | null = null;
    try {
      const { roles, botTopPosition } = await (await port()).roles();
      warning = roleWarning(input.roleId, roles, botTopPosition, deps.guildId());
    } catch { warning = null; }
    return { userIds, warning };
  };

  const bulkRoutes: OpsRoute[] = [
    { pattern: /^\/api\/v1\/admin-tools\/bulk-roles$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        const jobs = await g(() => stores.jobs.list(deps.guildId(), BULK_JOB_LIST_LIMIT));
        sendJson(response, 200, { jobs: jobs.map(jobDto) });
      } },
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const input = await g(async () => parseBulkRequest(await readJsonBody(request), true));
        const { userIds, warning } = await resolve(input);
        if (warning) throw badRequest(`The bot cannot ${input.action} that role: ${warning.message}`);
        if (!userIds.length) throw badRequest('No members match that target.');
        const job: StoredBulkJob = { id: randomUUID(), guildId: deps.guildId(), action: input.action, roleId: input.roleId,
          target: input.target, reason: input.reason, status: 'queued', total: userIds.length, done: 0, failed: 0, error: null,
          createdAtMs: deps.now(), startedAtMs: null, finishedAtMs: null, userIds, failures: [], createdBy: LOCAL_ADMIN.id };
        await g(() => stores.jobs.create(job));
        await deps.recordAudit('bulk_roles.queued', { jobId: job.id, action: job.action, roleId: job.roleId, target: job.target.kind,
          ...(job.target.kind === 'ids' ? {} : { eventId: job.target.eventId }), total: job.total, reason: job.reason });
        deps.notify('roles', job.id);
        if (deps.demo) void runner().kick();
        sendJson(response, 201, jobDto(job));
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/bulk-roles\/preview$/, methods: {
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const input = await g(async () => parseBulkRequest(await readJsonBody(request), false));
        const { userIds, warning } = await resolve(input);
        const body: BulkRolePreviewDto = { total: userIds.length, sample: userIds.slice(0, 10), warning };
        sendJson(response, 200, body);
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/bulk-roles/${ID}$`), methods: {
      GET: { access: 'members.read', run: async ({ response, params }) => {
        const job = await g(() => stores.jobs.get(deps.guildId(), params[0]!));
        if (!job) throw new HttpError(404, 'not_found', 'That bulk role job no longer exists.');
        sendJson(response, 200, jobDetail(job));
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/bulk-roles/${ID}/cancel$`), methods: {
      POST: { access: 'server.manage', run: async ({ response, params }) => {
        const job = await g(() => stores.jobs.cancel(deps.guildId(), params[0]!, deps.now()));
        await deps.recordAudit('bulk_roles.cancelled', { jobId: job.id, done: job.done, failed: job.failed, total: job.total });
        deps.notify('roles', job.id);
        sendJson(response, 200, jobDto(job));
      } }
    } }
  ];
  return [...panelRoutes, ...bulkRoutes];
}
