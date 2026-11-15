// Admin tools routes for announcements (agent C):
//   GET/POST /api/v1/admin-tools/announcements, PUT/DELETE /announcements/:id, POST /announcements/:id/send
import { randomUUID } from 'node:crypto';
import { readJsonBody } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { badRequest, onlyParams, type OpsRoute } from '../../ops/http.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { discordCall, routePort } from '../roles/port.js';
import { AnnouncementScheduler, announcementMessage, announcementView, deliverAnnouncement, MemoryAnnouncementStore,
  parseAnnouncementInput, pgAnnouncementStore, type AnnouncementInput, type AnnouncementStore, type StoredAnnouncement } from './announcements.js';
import { ANNOUNCEMENT_LIST_LIMIT, type AnnouncementListDto } from './types.js';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const DEMO_TICK_MS = 15_000;

export function announcementsRouteModule(overrides: { store?: AnnouncementStore; demoTimer?: boolean } = {}): AdminToolsRouteModule {
  return { name: 'announcements', routes: deps => announcementRoutes(deps, overrides) };
}

function announcementRoutes(deps: AdminToolsRouteDeps, overrides: Parameters<typeof announcementsRouteModule>[0] = {}): OpsRoute[] {
  const store = overrides.store ?? (deps.storage === 'postgres' ? pgAnnouncementStore() : new MemoryAnnouncementStore());
  const port = routePort(deps);
  const g = deps.guarded;
  const audit = (kind: Parameters<typeof deps.recordAudit>[0], payload: Record<string, unknown>) => deps.recordAudit(kind, payload);
  // The demo has no Discord feature runtime: scheduled sends run here (on each list and on a timer).
  const demoScheduler = deps.demo ? new AnnouncementScheduler({ store, guildId: deps.demo.id, port, now: deps.now, audit }) : null;
  if (demoScheduler && overrides.demoTimer !== false) setInterval(() => { void demoScheduler.tick().catch(() => {}); }, DEMO_TICK_MS).unref();

  const find = async (id: string) => {
    const item = await g(() => store.get(deps.guildId(), id));
    if (!item) throw new HttpError(404, 'not_found', 'That announcement no longer exists.');
    return item;
  };
  const parse = async (request: Parameters<typeof readJsonBody>[0]) =>
    g(async () => parseAnnouncementInput(await readJsonBody(request), deps.guildId(), deps.now()));
  const savedAudit = (item: StoredAnnouncement, created: boolean) => audit('announcement.saved', { announcementId: item.id,
    channelId: item.channelId, status: item.status, scheduledAtMs: item.scheduledAtMs, mentions: item.mentionRoleIds.length,
    everyone: item.mentionEveryone, created });
  /**
   * Marks it sent before the Discord call, conditional on the status the route read: a concurrent scheduler
   * claim or a second click gets 409 instead of a second post (at most once).
   */
  const claimForSend = (item: StoredAnnouncement, expected: StoredAnnouncement['status'], at: number) =>
    g(() => store.update({ ...item, status: 'sent', messageId: null, sentAtMs: at, error: null, updatedAtMs: at }, expected));
  const statusFor = (input: AnnouncementInput) => input.draft ? 'draft' as const : input.scheduledAtMs !== null ? 'scheduled' as const : null;

  return [
    { pattern: /^\/api\/v1\/admin-tools\/announcements$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        if (demoScheduler) await g(() => demoScheduler.tick());
        const items = await g(() => store.list(deps.guildId(), ANNOUNCEMENT_LIST_LIMIT));
        const body: AnnouncementListDto = { announcements: items.map(announcementView) };
        sendJson(response, 200, body);
      } },
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const input = await parse(request);
        const at = deps.now();
        const base: StoredAnnouncement = { id: randomUUID(), guildId: deps.guildId(), channelId: input.channelId, body: input.body,
          mentionRoleIds: input.mentionRoleIds, mentionEveryone: input.mentionEveryone, scheduledAtMs: input.scheduledAtMs,
          status: 'draft', messageId: null, sentAtMs: null, error: null, createdAtMs: at, updatedAtMs: at };
        const status = statusFor(input);
        let saved: StoredAnnouncement;
        if (status) {
          saved = await g(() => store.create({ ...base, status }));
          await savedAudit(saved, true);
        } else {
          const guild = await port();
          await savedAudit(base, true);
          saved = await g(() => deliverAnnouncement(store, guild, base, at, audit, 'create'));
        }
        deps.notify('announcements', saved.id);
        sendJson(response, 201, announcementView(saved));
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/announcements/${ID}$`), methods: {
      PUT: { access: 'server.manage', run: async ({ request, response, params }) => {
        const current = await find(params[0]!);
        const input = await parse(request);
        const at = deps.now();
        let saved: StoredAnnouncement;
        if (current.status === 'sent') {
          // A sent announcement is edited in place; its schedule and channel are history.
          if (input.channelId !== current.channelId) throw badRequest('A sent announcement stays in its channel. Delete it and send a new one.');
          const next: StoredAnnouncement = { ...current, body: input.body, mentionRoleIds: input.mentionRoleIds,
            mentionEveryone: input.mentionEveryone, updatedAtMs: at };
          if (current.messageId) {
            const messageId = current.messageId;
            const outcome = await discordCall(async () => (await port()).edit(current.channelId, messageId, announcementMessage(next)));
            if (outcome === 'missing') throw new HttpError(409, 'conflict', 'The message was deleted in Discord. Delete this entry or send it again as a new announcement.');
          }
          saved = await g(() => store.update(next));
          await savedAudit(saved, false);
        } else {
          const status = statusFor(input);
          const next: StoredAnnouncement = { ...current, channelId: input.channelId, body: input.body, mentionRoleIds: input.mentionRoleIds,
            mentionEveryone: input.mentionEveryone, scheduledAtMs: input.scheduledAtMs, error: null, updatedAtMs: at,
            status: status ?? current.status };
          // Conditional on the status we read, so an edit racing the scheduler's send can never re-schedule it.
          if (status) {
            saved = await g(() => store.update(next, current.status));
            await savedAudit(saved, false);
          } else {
            const guild = await port();
            const claimed = await claimForSend(next, current.status, at);
            await savedAudit(next, false);
            saved = await g(() => deliverAnnouncement(store, guild, claimed, at, audit, 'update'));
          }
        }
        deps.notify('announcements', saved.id);
        sendJson(response, 200, announcementView(saved));
      } },
      DELETE: { access: 'server.manage', run: async ({ response, params }) => {
        const item = await find(params[0]!);
        let messageDeleted = false;
        if (item.status === 'sent' && item.messageId) {
          const messageId = item.messageId;
          messageDeleted = (await discordCall(async () => (await port()).remove(item.channelId, messageId))) === 'ok';
        }
        await g(() => store.delete(deps.guildId(), item.id));
        await audit('announcement.deleted', { announcementId: item.id, channelId: item.channelId, status: item.status, messageDeleted });
        deps.notify('announcements', item.id);
        sendJson(response, 200, { deleted: true, messageDeleted });
      } }
    } },
    { pattern: new RegExp(`^/api/v1/admin-tools/announcements/${ID}/send$`), methods: {
      POST: { access: 'server.manage', run: async ({ response, params }) => {
        const item = await find(params[0]!);
        if (item.status === 'sent') throw new HttpError(409, 'conflict', 'That announcement was already sent.');
        const guild = await port();
        const at = deps.now();
        const claimed = await claimForSend({ ...item, scheduledAtMs: null }, item.status, at);
        const saved = await g(() => deliverAnnouncement(store, guild, claimed, at, audit, 'update'));
        deps.notify('announcements', saved.id);
        sendJson(response, 200, announcementView(saved));
      } }
    } }
  ];
}
