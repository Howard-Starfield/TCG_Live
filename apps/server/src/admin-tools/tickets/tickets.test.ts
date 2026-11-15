import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits, type BaseMessageOptions } from 'discord.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type TicketSettingsDto } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { LOCAL_ADMIN, MemoryOpsAuditStore } from '../../ops/audit.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { StickiesTicketsRuntime } from '../channels/runtime-status.js';
import { parseTicketCustomId, TICKET_IDS, ticketChannelName, transcriptSummary, type OverwriteSpec } from './messages.js';
import { ticketsRouteModule } from './routes.js';
import { closeTicket, openTicket, reopenTicket, ticketChannelDeleted, type TicketGateway, type TicketServiceDeps } from './service.js';
import { MemoryTicketStore, type TranscriptMessageInput } from './store.js';

const GUILD = DEMO_GUILD_ID;
const CATEGORY = '310000000000000001';
const STAFF = '310000000000000002';
const BOT = '310000000000000099';
const USER = { id: '310000000000000050', username: 'Ash Ketchum!' };
const HOUR = 3_600_000;

const settings = (patch: Partial<TicketSettingsDto> = {}): TicketSettingsDto => ({ ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS.tickets),
  enabled: true, supportChannelId: '310000000000000003', categoryId: CATEGORY, staffRoleIds: [STAFF], ...patch });

class FakeTickets implements TicketGateway {
  channels = new Set<string>();
  created: Array<{ name: string; overwrites: OverwriteSpec[] }> = [];
  sent: Array<{ channelId: string; message: BaseMessageOptions }> = [];
  deleted: string[] = [];
  members = new Set([USER.id]);
  transcript: { messages: TranscriptMessageInput[]; contentAvailable: boolean } = { messages: [], contentAvailable: true };
  createDelayMs = 0;
  failCreate: unknown = null;
  failDelete: unknown = null;
  private seq = 100;
  botUserId() { return BOT; }
  everyoneRoleId() { return GUILD; }
  async member(userId: string) { return this.members.has(userId) ? { username: 'ash' } : null; }
  async channelExists(channelId: string) { return this.channels.has(channelId); }
  async categoryExists(categoryId: string) { return categoryId === CATEGORY; }
  async createChannel(spec: { name: string; overwrites: OverwriteSpec[] }) {
    if (this.createDelayMs) await new Promise(resolve => setTimeout(resolve, this.createDelayMs));
    if (this.failCreate) throw this.failCreate;
    const id = `3200000000000${String(++this.seq).padStart(5, '0')}`;
    this.channels.add(id);
    this.created.push(spec);
    return id;
  }
  async send(channelId: string, message: BaseMessageOptions) { this.sent.push({ channelId, message }); return `33000000000000${String(this.sent.length).padStart(4, '0')}`; }
  async fetchTranscript() { return structuredClone(this.transcript); }
  async deleteChannel(channelId: string) { if (this.failDelete) throw this.failDelete; this.channels.delete(channelId); this.deleted.push(channelId); }
}

function fixture() {
  let now = Date.UTC(2026, 10, 14, 12);
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const store = new MemoryTicketStore(clock.now);
  const gateway = new FakeTickets();
  const audit = new MemoryOpsAuditStore(clock.now);
  const deps: TicketServiceDeps = { guildId: GUILD, store, gateway, now: clock.now,
    audit: (kind, payload, actor) => audit.append({ kind, payload, actor, guildId: GUILD }) };
  return { clock, store, gateway, audit, deps };
}

const line = (n: number, content: string, authorBot = false): TranscriptMessageInput => ({ messageId: `3400000000000${String(n).padStart(5, '0')}`,
  authorId: authorBot ? BOT : USER.id, authorName: authorBot ? 'TCG Live' : 'ash', authorBot, content, attachments: [], createdAtMs: Date.UTC(2026, 10, 14, 11, n) });

test('ticket names, custom IDs and the transcript summary', () => {
  assert.equal(ticketChannelName('ticket-{name}-{n}', 'Ash Ketchum!', 7), 'ticket-ash-ketchum-7');
  assert.equal(ticketChannelName('t-{n}', '', 1), 't-1');
  assert.equal(ticketChannelName('ticket-{name}-{n}', '😀', 2), 'ticket-member-2');
  const id = '0f1c8a2e-0b5d-4e0a-9a0e-2a1b3c4d5e6f';
  assert.deepEqual(parseTicketCustomId(TICKET_IDS.close(id)), { action: 'close', ticketId: id });
  assert.deepEqual(parseTicketCustomId(TICKET_IDS.open), { action: 'open' });
  assert.equal(parseTicketCustomId('tk:close:nope'), null);
  assert.ok(TICKET_IDS.confirm(id).length <= 100);
  const summary = transcriptSummary(3, [line(1, 'hi'), { ...line(2, ''), attachments: [{ name: 'a.png', url: 'https://x/a.png', size: 1 }] }, line(3, '')]);
  assert.match(summary, /Ticket #3 was reopened/);
  assert.match(summary, /\[1 attachment\(s\)\]/);
  assert.match(summary, /\[text not available\]/);
  assert.ok(transcriptSummary(1, Array.from({ length: 200 }, (_, i) => line(i % 59, 'x'.repeat(300)))).length <= 2000);
});

test('opening is idempotent per member, numbered, and sets private overwrites', async () => {
  const { gateway, deps, audit } = fixture();
  const first = await openTicket(deps, settings(), USER);
  assert.equal(first.kind, 'created');
  assert.ok(first.kind === 'created' && first.ticket.number === 1 && first.ticket.name === 'ticket-ash-ketchum-1');
  const again = await openTicket(deps, settings(), USER);
  assert.equal(again.kind, 'existing');
  assert.equal(gateway.created.length, 1);
  const overwrites = gateway.created[0]!.overwrites;
  const everyone = overwrites.find(item => item.id === GUILD)!;
  assert.equal(everyone.deny & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
  for (const id of [USER.id, STAFF, BOT]) {
    const item = overwrites.find(entry => entry.id === id);
    assert.ok(item && (item.allow & PermissionFlagsBits.ViewChannel) && (item.allow & PermissionFlagsBits.SendMessages), id);
  }
  assert.equal(overwrites.length, 4);
  assert.equal(gateway.sent.length, 1, 'welcome message with the Close button');
  assert.ok(JSON.stringify(gateway.sent[0]!.message.components).includes('tk:close:'));
  assert.deepEqual(audit.entries.map(entry => [entry.kind, entry.actorKind]), [['ticket.opened', 'player']]);
});

test('duplicate clicks at the same time create one channel', async () => {
  const { gateway, deps } = fixture();
  gateway.createDelayMs = 20;
  const outcomes = await Promise.all([openTicket(deps, settings(), USER), openTicket(deps, settings(), USER), openTicket(deps, settings(), USER)]);
  assert.equal(outcomes.filter(outcome => outcome.kind === 'created').length, 1);
  assert.ok(outcomes.every(outcome => outcome.kind === 'created' || outcome.kind === 'pending'));
  assert.equal(gateway.created.length, 1);
});

test('opening: disabled, missing category, permission errors, and a channel deleted by hand', async () => {
  const { gateway, deps, store } = fixture();
  assert.equal((await openTicket(deps, settings({ enabled: false }), USER)).kind, 'unavailable');
  const missing = await openTicket(deps, settings({ categoryId: '310000000000000777' }), USER);
  assert.ok(missing.kind === 'unavailable' && /category is missing/.test(missing.message));
  gateway.failCreate = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const denied = await openTicket(deps, settings(), USER);
  assert.ok(denied.kind === 'unavailable' && /Manage Channels/.test(denied.message));
  assert.equal((await store.list(GUILD, { status: 'deleted' })).tickets.length, 1, 'the failed attempt is retired, not left open');
  gateway.failCreate = null;
  const opened = await openTicket(deps, settings(), USER);
  assert.equal(opened.kind, 'created');
  gateway.channels.clear();   // deleted by hand while the bot was offline
  const fresh = await openTicket(deps, settings(), USER);
  assert.equal(fresh.kind, 'created');
  assert.ok(fresh.kind === 'created' && opened.kind === 'created' && fresh.ticket.number === opened.ticket.number + 1);
});

test('closing saves the transcript (with content), deletes the channel, and is not repeated', async () => {
  const { gateway, deps, store, audit } = fixture();
  const opened = await openTicket(deps, settings(), USER);
  assert.equal(opened.kind, 'created');
  if (opened.kind !== 'created') return;
  gateway.transcript = { messages: [line(1, 'Ticket #1', true), line(2, 'My opponent left')], contentAvailable: true };
  const result = await closeTicket(deps, opened.ticket.id, { kind: 'player', id: USER.id });
  assert.equal(result.ticket.status, 'closed');
  assert.equal(result.ticket.channelId, null);
  assert.equal(result.ticket.messageCount, 2);
  assert.ok(result.ticket.reopenableUntilMs! - result.ticket.closedAtMs! === 24 * HOUR);
  assert.deepEqual(gateway.deleted, [opened.channelId]);
  const transcript = await store.transcript(GUILD, opened.ticket.id);
  assert.deepEqual(transcript!.messages.map(message => [message.seq, message.content]), [[1, 'Ticket #1'], [2, 'My opponent left']]);
  await assert.rejects(closeTicket(deps, opened.ticket.id, LOCAL_ADMIN), /already closed/);
  const closed = audit.entries.find(entry => entry.kind === 'ticket.closed')!;
  assert.equal(closed.payload.contentAvailable, true);
  assert.equal(closed.actorId, USER.id);
  // Our own deletion is not reported as "deleted by hand".
  assert.equal(await ticketChannelDeleted(deps, opened.channelId), false);
});

test('closing without the Message Content intent keeps authors and times, notes content unavailable, and survives a delete failure', async () => {
  const { gateway, deps, store, audit } = fixture();
  const opened = await openTicket(deps, settings(), USER);
  if (opened.kind !== 'created') return assert.fail('not created');
  gateway.transcript = { messages: [line(1, 'Ticket #1', true), line(2, '')], contentAvailable: false };
  gateway.failDelete = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const result = await closeTicket(deps, opened.ticket.id, LOCAL_ADMIN);
  assert.equal(result.contentAvailable, false);
  assert.equal(result.channelDeleted, false);
  assert.match(result.warning ?? '', /Delete it by hand/);
  const transcript = await store.transcript(GUILD, opened.ticket.id);
  assert.deepEqual(transcript!.messages.map(message => [message.authorId, message.content]), [[BOT, 'Ticket #1'], [USER.id, '']]);
  assert.equal(audit.entries.find(entry => entry.kind === 'ticket.closed')!.payload.contentAvailable, false);
});

test('staff reopen within 24 h recreates the channel and posts the transcript; later or after leaving it is refused', async () => {
  const { gateway, deps, clock, audit } = fixture();
  const opened = await openTicket(deps, settings(), USER);
  if (opened.kind !== 'created') return assert.fail('not created');
  gateway.transcript = { messages: [line(1, 'Help please')], contentAvailable: true };
  await closeTicket(deps, opened.ticket.id, LOCAL_ADMIN);
  clock.advance(23 * HOUR);
  const reopened = await reopenTicket(deps, settings(), opened.ticket.id, LOCAL_ADMIN);
  assert.equal(reopened.status, 'open');
  assert.ok(reopened.channelId && gateway.channels.has(reopened.channelId));
  assert.match(String(gateway.sent.at(-2)!.message.content), /Help please/);
  assert.ok(audit.entries.some(entry => entry.kind === 'ticket.reopened'));
  await assert.rejects(reopenTicket(deps, settings(), opened.ticket.id, LOCAL_ADMIN), /Only a closed ticket/);
  gateway.transcript = { messages: [line(3, 'Thanks')], contentAvailable: true };
  const closedAgain = await closeTicket(deps, opened.ticket.id, LOCAL_ADMIN);
  assert.equal(closedAgain.ticket.messageCount, 2, 'the second transcript is appended');
  clock.advance(25 * HOUR);
  await assert.rejects(reopenTicket(deps, settings(), opened.ticket.id, LOCAL_ADMIN), /24-hour window/);
  // A fresh close, then the member leaves.
  const other = fixture();
  const ticket = await openTicket(other.deps, settings(), USER);
  if (ticket.kind !== 'created') return assert.fail('not created');
  await closeTicket(other.deps, ticket.ticket.id, LOCAL_ADMIN);
  other.gateway.members.clear();
  await assert.rejects(reopenTicket(other.deps, settings(), ticket.ticket.id, LOCAL_ADMIN), /left the server/);
});

test('reopen is refused while the member has another open ticket', async () => {
  const { deps } = fixture();
  const first = await openTicket(deps, settings(), USER);
  if (first.kind !== 'created') return assert.fail('not created');
  await closeTicket(deps, first.ticket.id, LOCAL_ADMIN);
  assert.equal((await openTicket(deps, settings(), USER)).kind, 'created');
  await assert.rejects(reopenTicket(deps, settings(), first.ticket.id, LOCAL_ADMIN), /another open ticket/);
});

test('a ticket channel deleted by hand marks the ticket deleted and audits it', async () => {
  const { deps, store, audit } = fixture();
  const opened = await openTicket(deps, settings(), USER);
  if (opened.kind !== 'created') return assert.fail('not created');
  assert.equal(await ticketChannelDeleted(deps, opened.channelId), true);
  const ticket = await store.get(GUILD, opened.ticket.id);
  assert.equal(ticket!.status, 'deleted');
  assert.equal(ticket!.reopenableUntilMs, null);
  assert.ok(audit.entries.some(entry => entry.kind === 'ticket.deleted'));
});

test('retention purge removes only old closed tickets', async () => {
  const { deps, store, clock } = fixture();
  const opened = await openTicket(deps, settings(), USER);
  if (opened.kind !== 'created') return assert.fail('not created');
  await closeTicket(deps, opened.ticket.id, LOCAL_ADMIN);
  await openTicket(deps, settings(), USER);
  clock.advance(10 * 86_400_000);
  assert.equal(await store.purgeClosedBefore(GUILD, clock.now() - 5 * 86_400_000), 1);
  assert.deepEqual((await store.list(GUILD)).tickets.map(ticket => ticket.status), ['open']);
});

// ---------------------------------------------------------------- routes and settings (demo)

function adminTools(): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [ticketsRouteModule({ runtime: new StickiesTicketsRuntime() })] };
}

test('ticket routes: list, transcript, close and reopen in the demo; settings validation', async () => {
  const options = adminTools();
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const page = (await call(harness.port, '/api/v1/admin-tools/tickets', { token })).json();
    assert.equal(page.tickets.length, 3);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/tickets?status=open', { token })).json().tickets.length, 1);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/tickets?status=bogus', { token })).status, 400);
    const recent = page.tickets.find((ticket: { status: string; reopenableUntilMs: number | null }) => ticket.status === 'closed' && ticket.reopenableUntilMs! > Date.now());
    const old = page.tickets.find((ticket: { status: string; reopenableUntilMs: number | null }) => ticket.status === 'closed' && ticket.reopenableUntilMs! < Date.now());
    const open = page.tickets.find((ticket: { status: string }) => ticket.status === 'open');
    const transcript = (await call(harness.port, `/api/v1/admin-tools/tickets/${recent.id}/transcript`, { token })).json();
    assert.equal(transcript.messages.length, 4);

    // Settings: enabling needs a category; a reserved support channel is refused.
    const body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
    const put = (settings: AdminToolsSettingsBodyDto, expectedVersion = 0) => call(harness.port, '/api/v1/admin-tools/settings',
      { method: 'PUT', token, body: JSON.stringify({ expectedVersion, settings }) });
    body.tickets = { ...body.tickets, enabled: true, supportChannelId: DEMO_CHANNEL_IDS.support, categoryId: null, staffRoleIds: [DEMO_ROLE_IDS.judge] };
    assert.equal((await put(body)).status, 400);
    body.tickets.categoryId = '200000000000000404';
    body.tickets.supportChannelId = DEMO_CHANNEL_IDS.signup;
    assert.match((await put(body)).json().error.message, /signup channel/);
    body.tickets.supportChannelId = DEMO_CHANNEL_IDS.support;
    body.tickets.namingPattern = 'Ticket {name}';
    assert.equal((await put(body)).status, 400);
    body.tickets.namingPattern = 'ticket-{name}-{n}';
    assert.equal((await put(body)).status, 200);

    const reopen = await call(harness.port, `/api/v1/admin-tools/tickets/${recent.id}/reopen`, { method: 'POST', token });
    assert.equal(reopen.status, 200, reopen.text);
    assert.equal(reopen.json().status, 'open');
    assert.equal((await call(harness.port, `/api/v1/admin-tools/tickets/${old.id}/reopen`, { method: 'POST', token })).status, 409);
    const close = await call(harness.port, `/api/v1/admin-tools/tickets/${open.id}/close`, { method: 'POST', token });
    assert.equal(close.status, 200, close.text);
    assert.equal(close.json().ticket.status, 'closed');
    assert.equal((await call(harness.port, `/api/v1/admin-tools/tickets/${open.id}/close`, { method: 'POST', token })).status, 409);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/tickets/panel', { method: 'POST', token })).status, 200);
    const kinds = (options.audit as MemoryOpsAuditStore).entries.map(entry => entry.kind);
    for (const kind of <const>['ticket.reopened', 'ticket.closed', 'ticket.settings']) assert.ok(kinds.includes(kind), kind);
  } finally { await harness.stop(); }
});
