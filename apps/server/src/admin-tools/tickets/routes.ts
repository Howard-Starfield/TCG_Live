// Route module "tickets" (agent B): ticket list, transcripts, dashboard close/reopen and "post/refresh
// panel". Ticket settings live in the shared settings document (section `tickets`, saved by the foundation).
import { TICKET_STATUSES, type TicketStatus } from '@tcg-live/core';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { integerQuery, onlyParams, UUID } from '../../ops/http.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { stickiesTicketsRuntime, type StickiesTicketsRuntime } from '../channels/runtime-status.js';
import { demoTicketGateway, liveTicketGateway } from './gateways.js';
import { closeTicket, reopenTicket, type TicketGateway, type TicketServiceDeps } from './service.js';
import { MemoryTicketStore, pgTicketStore, TICKET_PAGE_LIMIT, type TicketStore } from './store.js';

export interface TicketsModuleOptions {
  store?: TicketStore;
  gateway?(deps: AdminToolsRouteDeps): Promise<TicketGateway>;
  runtime?: StickiesTicketsRuntime;
}

const HOUR = 3_600_000;

/** Demo data: one open ticket, one closed 2 h ago (reopenable) and one closed 3 days ago. */
async function seedDemoTickets(store: TicketStore, gateway: TicketGateway, deps: AdminToolsRouteDeps, setClock: (ms: number | null) => void) {
  const guildId = deps.guildId();
  const members = deps.demo!.members.filter(member => !member.bot);
  const now = deps.now();
  const plan = [{ member: members[3], openedAgo: 80 * HOUR, closedAgo: 72 * HOUR }, { member: members[2], openedAgo: 5 * HOUR, closedAgo: 2 * HOUR },
    { member: members[4], openedAgo: HOUR, closedAgo: null }];
  for (const item of plan) {
    if (!item.member) continue;
    setClock(now - item.openedAgo);
    const { ticket } = await store.open(guildId, item.member.id, n => `ticket-${item.member!.username}-${n}`);
    const channelId = await gateway.createChannel({ name: ticket.name, categoryId: '', overwrites: [], reason: 'demo' });
    await store.setChannel(guildId, ticket.id, channelId);
    if (item.closedAgo === null) continue;
    setClock(now - item.closedAgo);
    const at = (minutes: number) => now - item.openedAgo + minutes * 60_000;
    await store.close(guildId, ticket.id, 'local-admin', 'closed', [
      { messageId: `${BigInt(channelId) + 1n}`, authorId: deps.demo!.members.find(member => member.bot)?.id ?? item.member.id, authorName: 'TCG Live',
        authorBot: true, content: `Ticket #${ticket.number}: Describe your issue and a staff member will answer here.`, attachments: [], createdAtMs: at(0) },
      { messageId: `${BigInt(channelId) + 2n}`, authorId: item.member.id, authorName: item.member.username, authorBot: false,
        content: 'My opponent did not show up for round 2.', attachments: [], createdAtMs: at(2) },
      { messageId: `${BigInt(channelId) + 3n}`, authorId: item.member.id, authorName: item.member.username, authorBot: false,
        content: '', attachments: [{ name: 'screenshot.png', url: 'https://cdn.discordapp.com/attachments/demo/screenshot.png', size: 48_213 }], createdAtMs: at(3) },
      { messageId: `${BigInt(channelId) + 4n}`, authorId: members[0]?.id ?? item.member.id, authorName: members[0]?.username ?? 'staff', authorBot: false,
        content: 'Thanks, the match is marked as a no-show win for you.', attachments: [], createdAtMs: at(9) }]);
    await store.setChannel(guildId, ticket.id, null);
  }
  setClock(null);
}

export function ticketsRouteModule(options: TicketsModuleOptions = {}): AdminToolsRouteModule {
  return {
    name: 'tickets',
    routes(deps) {
      let clock: number | null = null;
      const now = () => clock ?? deps.now();
      const store = options.store ?? (deps.storage === 'memory' ? new MemoryTicketStore(now) : pgTicketStore(deps.now));
      const runtime = options.runtime ?? stickiesTicketsRuntime;
      const demoGateway = deps.demo ? demoTicketGateway(deps.demo, deps.now) : null;
      const gateway = async (): Promise<TicketGateway> => {
        if (options.gateway) return options.gateway(deps);
        if (demoGateway) return demoGateway;
        if (!deps.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
        return liveTicketGateway(await deps.discord.guild());
      };
      let seeded = !deps.demo || !!options.store;
      const seed = async () => {
        if (seeded) return;
        seeded = true;
        await seedDemoTickets(store, demoGateway!, deps, ms => { clock = ms; }).catch(() => { clock = null; });
      };
      const service = async (): Promise<TicketServiceDeps> => ({ guildId: deps.guildId(), store, gateway: await gateway(), now: deps.now,
        audit: (kind, payload, actor) => deps.recordAudit(kind, payload, actor) });
      const ticketId = (params: string[]) => {
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw new HttpError(404, 'not_found', 'That ticket does not exist.');
        return id.toLowerCase();
      };

      return [
        { pattern: /^\/api\/v1\/admin-tools\/tickets$/, methods: {
          GET: { access: 'members.read', run: async ({ response, query }) => {
            onlyParams(query, ['status', 'before', 'limit']);
            const raw = query.get('status');
            if (raw !== null && !(TICKET_STATUSES as readonly string[]).includes(raw)) throw new HttpError(400, 'bad_request', 'Choose a valid ticket status.');
            const before = query.get('before') === null ? null : integerQuery(query, 'before', 1, 1, 2_147_483_647);
            const limit = integerQuery(query, 'limit', 50, 1, TICKET_PAGE_LIMIT);
            await seed();
            sendJson(response, 200, await deps.guarded(() => store.list(deps.guildId(), { status: raw as TicketStatus | null, before, limit })));
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/tickets\/panel$/, methods: {
          GET: { access: 'members.read', run: async ({ response }) => {
            sendJson(response, 200, { status: deps.demo ? { state: 'posted', message: null, atMs: deps.now() } : runtime.panel });
          } },
          POST: { access: 'server.manage', run: async ({ response }) => {
            const settings = await deps.currentSettings();
            if (!settings.tickets.enabled || !settings.tickets.supportChannelId)
              throw new HttpError(400, 'bad_request', 'Turn tickets on and choose a support channel, then save, before posting the panel.');
            if ((await deps.reservedChannelIds()).has(settings.tickets.supportChannelId))
              throw new HttpError(400, 'bad_request', 'The ticket panel cannot live in a tournament channel. Choose another support channel.');
            let result = { ok: true, messageId: null as string | null, message: 'The demo has no Discord; the panel would be posted now.' };
            if (!deps.demo) {
              const refresh = runtime.panelRefresher();
              if (!refresh) throw new HttpError(503, 'unavailable', 'The bot is not running. Start it, then try again.');
              result = await refresh();
            }
            await deps.recordAudit('ticket.settings', { action: 'panel-posted', channelId: settings.tickets.supportChannelId, ok: result.ok, messageId: result.messageId });
            if (!result.ok) throw new HttpError(400, 'bad_request', result.message);
            sendJson(response, 200, result);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/tickets\/([^/]+)\/transcript$/, methods: {
          GET: { access: 'members.read', run: async ({ response, params }) => {
            const id = ticketId(params);
            await seed();
            const transcript = await deps.guarded(() => store.transcript(deps.guildId(), id));
            if (!transcript) throw new HttpError(404, 'not_found', 'That ticket does not exist.');
            sendJson(response, 200, transcript);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/tickets\/([^/]+)\/close$/, methods: {
          POST: { access: 'members.moderate', run: async ({ response, params }) => {
            const id = ticketId(params);
            const context = await service();
            const result = await deps.guarded(() => closeTicket(context, id, LOCAL_ADMIN));
            sendJson(response, 200, result);
          } }
        } },
        { pattern: /^\/api\/v1\/admin-tools\/tickets\/([^/]+)\/reopen$/, methods: {
          POST: { access: 'members.moderate', run: async ({ response, params }) => {
            const id = ticketId(params);
            const settings = await deps.currentSettings();
            const context = await service();
            sendJson(response, 200, await deps.guarded(() => reopenTicket(context, settings.tickets, id, LOCAL_ADMIN)));
          } }
        } }
      ];
    }
  };
}
