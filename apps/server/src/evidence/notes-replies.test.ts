import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVIDENCE_NOTE_TEXT_MAX_LENGTH, EVIDENCE_REPLY_MAX_LENGTH, EVIDENCE_REPLY_STALE_MS, OPS_AUDIT_KINDS } from '@tcg-live/core';
import { demoOpsOptions } from '../admin/demo.js';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { LOCAL_ADMIN, MemoryOpsAuditStore } from '../ops/audit.js';
import { createReplyDelivery, matchReplyMessage, replyNonce, ReplyDeliveryError, type EvidenceReplyDelivery, type MatchRoomMessage } from './replies.js';
import { MemoryEvidenceStore } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const base = `/api/v1/events/${eventId}/matches/M1/evidence`;
const replies = `${base}/replies`;
const json = (body: unknown) => JSON.stringify(body);
const ALPHA = '111111111111111111';
const BRAVO = '222222222222222222';

function evidence(replyDelivery?: EvidenceReplyDelivery, now?: () => number) {
  const audit = new MemoryOpsAuditStore();
  return { audit, store: new MemoryEvidenceStore(audit, now), ...(replyDelivery ? { replyDelivery } : {}) };
}

/** A delivery over fake Discord: records what would be posted and can be told to fail. */
function fakeDiscord(options: { seats?: string[] } = {}) {
  const posted: Array<{ matchId: string; message: MatchRoomMessage; nonce: string }> = [];
  const state = { failure: null as unknown, ready: true };
  const delivery = createReplyDelivery({
    ready: () => state.ready,
    seatedPlayers: async () => options.seats ?? [ALPHA, BRAVO],
    post: async (matchId, message, nonce) => {
      if (state.failure) throw state.failure;
      posted.push({ matchId, message, nonce });
      return String(900000000000000000n + BigInt(posted.length));
    }
  });
  return { delivery, posted, state };
}

// ---------------------------------------------------------------- text-only evidence (kind note)

test('a text note saves without any attachment and lists with its text', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const created = await call(harness.port, base, { method: 'POST', token, body: json({ kind: 'note', text: '  Ben showed a hand of 8 cards.\nSecond line.  ' }) });
    assert.equal(created.status, 201, created.text);
    const item = created.json().item;
    assert.equal(item.kind, 'note');
    assert.equal(item.note, 'Ben showed a hand of 8 cards.\nSecond line.');
    assert.equal(item.status, 'stored');
    assert.equal(item.externalUrl, null);
    assert.equal(item.originalName, null);
    assert.equal(item.playable, false);
    assert.equal(item.submittedBy, 'local-admin');
    assert.equal('storagePath' in item, false);
    const listed = (await call(harness.port, base, { token })).json();
    assert.deepEqual(listed.items.map((entry: { id: string }) => entry.id), [item.id]);
    assert.deepEqual(options.audit.entries.map(entry => entry.kind), ['evidence.submitted']);
    assert.equal(JSON.stringify(options.audit.entries[0]!.payload).includes('hand of 8'), false, 'the text is not copied into the audit');
  } finally { await harness.stop(); }
});

test('note validation: text is required, bounded, readable and not mixed with link fields', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const post = (body: unknown) => call(harness.port, base, { method: 'POST', token, body: json(body) });
    assert.equal((await post({ kind: 'note' })).status, 400);
    assert.equal((await post({ kind: 'note', text: '   ' })).status, 400);
    assert.equal((await post({ kind: 'note', text: 7 })).status, 400);
    assert.equal((await post({ kind: 'note', text: 'bell\u0007' })).status, 400);
    assert.equal((await post({ kind: 'note', text: 'x'.repeat(EVIDENCE_NOTE_TEXT_MAX_LENGTH + 1) })).status, 400);
    assert.equal((await post({ kind: 'note', text: 'ok', url: 'https://x.y' })).status, 400);
    assert.equal((await post({ kind: 'note', text: 'ok', note: 'caption' })).status, 400);
    assert.equal((await post({ kind: 'note', text: 'ok', extra: 1 })).status, 400);
    assert.equal((await post({ kind: 'upload', text: 'ok' })).status, 400);
    assert.equal((await post({ url: 'https://x.y', text: 'ok' })).status, 400, 'text without kind note');
    assert.equal(options.store.records.size, 0);
    // The longest allowed note and tabs and line breaks are fine; astral characters count once.
    assert.equal((await post({ kind: 'note', text: `a\tb\r\n${'x'.repeat(EVIDENCE_NOTE_TEXT_MAX_LENGTH - 5)}` })).status, 201);
    assert.equal((await post({ kind: 'note', text: '😀'.repeat(EVIDENCE_NOTE_TEXT_MAX_LENGTH) })).status, 201);
    // Links still work the old way, with or without an explicit kind.
    assert.equal((await post({ url: 'https://youtu.be/abc' })).status, 201);
    assert.equal((await post({ kind: 'link', url: 'https://youtu.be/abd', note: 'turn 2' })).status, 201);
  } finally { await harness.stop(); }
});

test('notes follow the evidence rules: manage capability, hold, soft delete with a reason, no playback ticket', async () => {
  const options = evidence();
  const reader = await startHarness({ evidence: options }, { capabilities: ['dashboard.read', 'evidence.read'] });
  try {
    const token = await login(reader);
    assert.equal((await call(reader.port, base, { method: 'POST', token, body: json({ kind: 'note', text: 'x' }) })).status, 403);
  } finally { await reader.stop(); }
  const harness = await startHarness({ evidence: { ...options, seams: {
    async playback() { throw new Error('a note must never reach the ticket seam'); } } } });
  try {
    const token = await login(harness);
    const id = (await call(harness.port, base, { method: 'POST', token, body: json({ kind: 'note', text: 'Opponent stalled' }) })).json().item.id;
    const ticket = await call(harness.port, `/api/v1/evidence/${id}/playback`, { method: 'POST', token });
    assert.equal(ticket.status, 400, ticket.text);
    assert.match(ticket.json().error.message ?? ticket.text, /text note/i);
    assert.equal((await call(harness.port, `/api/v1/evidence/${id}`, { method: 'PATCH', token, body: json({ hold: true }) })).json().item.hold, true);
    assert.equal((await call(harness.port, `/api/v1/evidence/${id}`, { method: 'DELETE', token, body: json({ reason: 'dup' }) })).status, 409);
    await call(harness.port, `/api/v1/evidence/${id}`, { method: 'PATCH', token, body: json({ hold: false }) });
    assert.equal((await call(harness.port, `/api/v1/evidence/${id}`, { method: 'DELETE', token, body: json({}) })).status, 400);
    const deleted = await call(harness.port, `/api/v1/evidence/${id}`, { method: 'DELETE', token, body: json({ reason: 'typo' }) });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json().item.status, 'deleted');
    assert.deepEqual(options.audit.entries.map(entry => entry.kind),
      ['evidence.submitted', 'evidence.hold', 'evidence.hold', 'evidence.deleted']);
  } finally { await harness.stop(); }
});

// ---------------------------------------------------------------- reply thread

test('evidence.reply is a registered audit kind', () => {
  assert.ok((OPS_AUDIT_KINDS as readonly string[]).includes('evidence.reply'));
});

test('a staff-only reply is kept in the thread and never reaches Discord', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const created = await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'Check the VOD first.', audience: 'staff' }) });
    assert.equal(created.status, 201, created.text);
    const reply = created.json().reply;
    assert.equal(reply.audience, 'staff');
    assert.equal(reply.status, 'recorded');
    assert.equal(reply.author, 'local-admin');
    assert.equal(reply.discordMessageId, null);
    assert.equal(discord.posted.length, 0);
    const listed = (await call(harness.port, replies, { token })).json();
    assert.deepEqual(listed, { eventId, matchId: 'M1', replies: [reply] });
    assert.deepEqual((await call(harness.port, `/api/v1/events/${eventId}/matches/M2/evidence/replies`, { token })).json().replies, []);
  } finally { await harness.stop(); }
});

test('a players reply posts to the match room mentioning only the seated players', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const created = await call(harness.port, replies, { method: 'POST', token,
      body: json({ body: '@everyone <@&999999999999999999> please send the clip', audience: 'players' }) });
    assert.equal(created.status, 201, created.text);
    const reply = created.json().reply;
    assert.equal(reply.status, 'delivered');
    assert.match(reply.discordMessageId, /^\d{18}$/);
    assert.equal(discord.posted.length, 1);
    const { matchId, message } = discord.posted[0]!;
    assert.equal(matchId, 'M1');
    assert.deepEqual(message.allowedMentions, { parse: [], users: [ALPHA, BRAVO] });
    assert.equal('roles' in message.allowedMentions, false);
    assert.ok(message.content.includes(`<@${ALPHA}>`) && message.content.includes(`<@${BRAVO}>`));
    assert.equal(message.embeds[0]!.description, '@everyone <@&999999999999999999> please send the clip');
    assert.deepEqual(options.audit.entries.map(entry => [entry.kind, entry.payload.stage]),
      [['evidence.reply', 'created'], ['evidence.reply', 'delivered']]);
    assert.equal(options.audit.entries.every(entry => !JSON.stringify(entry.payload).includes('send the clip')), true, 'no reply text in the audit');
    assert.equal(options.audit.entries[0]!.actorId, 'local-admin');
  } finally { await harness.stop(); }
});

test('a failed delivery keeps the reply as not delivered, and Retry posts it once', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    discord.state.failure = Object.assign(new Error('Missing Permissions: raw driver text'), { code: 50013 });
    const created = await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'Send the clip', audience: 'players' }) });
    assert.equal(created.status, 201, created.text);
    const failed = created.json().reply;
    assert.equal(failed.status, 'failed');
    assert.match(failed.deliveryError, /not allowed to post/);
    assert.equal(JSON.stringify(failed).includes('raw driver text'), false);
    assert.equal((await call(harness.port, replies, { token })).json().replies[0].status, 'failed');
    // Retry while Discord still fails: still kept, still failed.
    const again = await call(harness.port, `${replies}/${failed.id}/retry`, { method: 'POST', token, body: json({}) });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json().reply.status, 'failed');
    // Then Discord recovers.
    discord.state.failure = null;
    const retried = await call(harness.port, `${replies}/${failed.id}/retry`, { method: 'POST', token, body: json({}) });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json().reply.status, 'delivered');
    assert.equal(retried.json().reply.deliveryError, null);
    assert.equal(discord.posted.length, 1);
    // A delivered reply cannot be posted a second time.
    assert.equal((await call(harness.port, `${replies}/${failed.id}/retry`, { method: 'POST', token, body: json({}) })).status, 409);
    assert.equal(discord.posted.length, 1);
    assert.deepEqual(options.audit.entries.map(entry => entry.payload.stage),
      ['created', 'failed', 'retry', 'failed', 'retry', 'delivered']);
  } finally { await harness.stop(); }
});

test('retry refuses another match, unknown ids and staff-only replies', async () => {
  const discord = fakeDiscord();
  const harness = await startHarness({ evidence: evidence(discord.delivery) });
  try {
    const token = await login(harness);
    const staff = (await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'note', audience: 'staff' }) })).json().reply;
    assert.equal((await call(harness.port, `${replies}/${staff.id}/retry`, { method: 'POST', token, body: json({}) })).status, 409);
    const other = `/api/v1/events/${eventId}/matches/M2/evidence/replies/${staff.id}/retry`;
    assert.equal((await call(harness.port, other, { method: 'POST', token, body: json({}) })).status, 404);
    assert.equal((await call(harness.port, `${replies}/22222222-2222-4222-8222-222222222222/retry`, { method: 'POST', token, body: json({}) })).status, 404);
    assert.equal((await call(harness.port, `${replies}/not-a-uuid/retry`, { method: 'POST', token, body: json({}) })).status, 404);
  } finally { await harness.stop(); }
});

test('an unexpected delivery error is never shown to the admin', async () => {
  const options = evidence({ async deliver() { throw new Error('connect ECONNREFUSED 10.0.0.1:5432 secret-token'); } });
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const reply = (await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) })).json().reply;
    assert.equal(reply.status, 'failed');
    assert.equal(reply.deliveryError, 'Discord could not deliver this message.');
  } finally { await harness.stop(); }
});

test('delivery refusals are readable: Discord offline, no live match room, no seated players', async () => {
  const discord = fakeDiscord();
  const harness = await startHarness({ evidence: evidence(discord.delivery) });
  try {
    const token = await login(harness);
    discord.state.ready = false;
    assert.match((await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'a', audience: 'players' }) })).json().reply.deliveryError, /not connected/);
    discord.state.ready = true;
  } finally { await harness.stop(); }
  const none = fakeDiscord({ seats: [] });
  const empty = await startHarness({ evidence: evidence(none.delivery) });
  try {
    const token = await login(empty);
    assert.match((await call(empty.port, replies, { method: 'POST', token, body: json({ body: 'a', audience: 'players' }) })).json().reply.deliveryError, /no seated players/);
    assert.equal(none.posted.length, 0);
  } finally { await empty.stop(); }
  const stranger = await startHarness({ evidence: evidence({ async deliver() { throw new ReplyDeliveryError('That is not the active Discord tournament.'); } }) });
  try {
    const token = await login(stranger);
    assert.equal((await call(stranger.port, replies, { method: 'POST', token, body: json({ body: 'a', audience: 'players' }) })).json().reply.deliveryError,
      'That is not the active Discord tournament.');
  } finally { await stranger.stop(); }
});

test('without Discord delivery a players reply is refused up front and nothing is stored; staff replies still work', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const refused = await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) });
    assert.equal(refused.status, 503, refused.text);
    assert.equal(options.store.replies.size, 0);
    assert.equal((await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'staff' }) })).status, 201);
    assert.equal((await call(harness.port, `${replies}/${[...options.store.replies.keys()][0]}/retry`, { method: 'POST', token, body: json({}) })).status, 503);
  } finally { await harness.stop(); }
});

test('reply validation: audience is required, body is bounded and readable, no extra fields', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const post = (body: unknown) => call(harness.port, replies, { method: 'POST', token, body: json(body) });
    assert.equal((await post({ body: 'hello' })).status, 400, 'no default audience: nothing posts to Discord by accident');
    assert.equal((await post({ body: 'hello', audience: 'everyone' })).status, 400);
    assert.equal((await post({ audience: 'staff' })).status, 400);
    assert.equal((await post({ body: '   ', audience: 'staff' })).status, 400);
    assert.equal((await post({ body: 'x'.repeat(EVIDENCE_REPLY_MAX_LENGTH + 1), audience: 'staff' })).status, 400);
    assert.equal((await post({ body: 'bell\u0007', audience: 'staff' })).status, 400);
    assert.equal((await post({ body: 'hi', audience: 'staff', author: '123' })).status, 400);
    assert.equal((await post({ body: 'x'.repeat(EVIDENCE_REPLY_MAX_LENGTH), audience: 'staff' })).status, 201);
    assert.equal(discord.posted.length, 0);
    assert.equal((await call(harness.port, `${replies}?x=1`, { token })).status, 400);
    assert.equal((await call(harness.port, `/api/v1/events/not-a-uuid/matches/M1/evidence/replies`, { token })).status, 400);
  } finally { await harness.stop(); }
});

test('replies need match.judge (so read-only sessions cannot send); reading needs evidence.read', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const readOnly = await startHarness({ evidence: options }, { capabilities: ['dashboard.read', 'evidence.read'] });
  try {
    const token = await login(readOnly);
    assert.equal((await call(readOnly.port, replies, { token })).status, 200);
    for (const audience of ['staff', 'players']) {
      assert.equal((await call(readOnly.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience }) })).status, 403, audience);
    }
    assert.equal((await call(readOnly.port, `${replies}/${eventId}/retry`, { method: 'POST', token, body: json({}) })).status, 403);
    assert.equal(options.store.replies.size, 0);
    assert.equal(discord.posted.length, 0);
  } finally { await readOnly.stop(); }
  // Evidence managers without match.judge cannot answer players either.
  const manager = await startHarness({ evidence: options }, { capabilities: ['dashboard.read', 'evidence.read', 'evidence.manage'] });
  try {
    const token = await login(manager);
    assert.equal((await call(manager.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) })).status, 403);
  } finally { await manager.stop(); }
  const blind = await startHarness({ evidence: options }, { capabilities: ['dashboard.read'] });
  try {
    const token = await login(blind);
    assert.equal((await call(blind.port, replies, { token })).status, 403);
  } finally { await blind.stop(); }
  // Dashboard actions off: the default capability set is read-only, so nothing is sent.
  const off = await startHarness({ evidence: options, commandsEnabled: false });
  try {
    const token = await login(off);
    assert.equal((await call(off.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) })).status, 403);
    assert.equal(discord.posted.length, 0);
  } finally { await off.stop(); }
});

test('a reply stuck pending (the process stopped mid-post) reads as failed and can be retried', async () => {
  let clock = 1_000_000;
  const discord = fakeDiscord();
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit, () => clock);
  const pending = await store.createReply({ eventId, matchId: 'M1', body: 'hello', audience: 'players', author: 'local-admin', actor: LOCAL_ADMIN });
  assert.equal(pending.status, 'pending');
  assert.equal((await store.listReplies(eventId, 'M1'))[0]!.status, 'pending');
  await assert.rejects(store.claimReplyRetry(pending.id, LOCAL_ADMIN), /not waiting for a retry/);
  clock += EVIDENCE_REPLY_STALE_MS + 1;
  const stale = (await store.listReplies(eventId, 'M1'))[0]!;
  assert.equal(stale.status, 'failed');
  assert.match(stale.deliveryError ?? '', /interrupted/);
  const harness = await startHarness({ evidence: { store, audit, replyDelivery: discord.delivery } });
  try {
    const token = await login(harness);
    const retried = await call(harness.port, `${replies}/${pending.id}/retry`, { method: 'POST', token, body: json({}) });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json().reply.status, 'delivered');
  } finally { await harness.stop(); }
});

test('matchReplyMessage allow-lists the seated players once each and nothing else', () => {
  const message = matchReplyMessage('M3', [ALPHA, BRAVO, ALPHA], 'hello');
  assert.deepEqual(message.allowedMentions, { parse: [], users: [ALPHA, BRAVO] });
  assert.equal(message.content.split(`<@${ALPHA}>`).length, 2);
  assert.equal(message.content.includes('@everyone') || message.content.includes('@here') || message.content.includes('<@&'), false);
  assert.ok(message.content.includes('M3'));
});

test('the in-memory demo supports text notes and replies, with Discord delivery faked as delivered', async () => {
  const harness = await startHarness(demoOpsOptions());
  try {
    const token = await login(harness);
    const note = await call(harness.port, base, { method: 'POST', token, body: json({ kind: 'note', text: 'Demo note' }) });
    assert.equal(note.status, 201, note.text);
    assert.equal(note.json().item.kind, 'note');
    const players = await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'Demo reply', audience: 'players' }) });
    assert.equal(players.status, 201, players.text);
    assert.equal(players.json().reply.status, 'delivered');
    const staff = await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'Demo staff note', audience: 'staff' }) });
    assert.equal(staff.json().reply.status, 'recorded');
    assert.equal((await call(harness.port, replies, { token })).json().replies.length, 2);
  } finally { await harness.stop(); }
});

test('deleting a note removes its text from the store and every read', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const id = (await call(harness.port, base, { method: 'POST', token, body: json({ kind: 'note', text: 'Private mistake' }) })).json().item.id;
    const deleted = await call(harness.port, `/api/v1/evidence/${id}`, { method: 'DELETE', token, body: json({ reason: 'wrong match' }) });
    assert.equal(deleted.json().item.note, '');
    assert.equal(options.store.records.get(id)!.note, '', 'the stored text itself is gone');
    const listed = (await call(harness.port, base, { token })).json().items[0];
    assert.equal(listed.status, 'deleted');
    assert.equal(listed.note, '');
    assert.equal(JSON.stringify(options.audit.entries).includes('Private mistake'), false);
  } finally { await harness.stop(); }
});

test('a captioned link keeps its caption when deleted (only notes are their text)', async () => {
  const store = new MemoryEvidenceStore(new MemoryOpsAuditStore());
  const link = await store.createLink({ eventId, matchId: 'M1', url: 'https://youtu.be/x', note: 'turn 3', source: 'web', submittedBy: 'local-admin', actor: LOCAL_ADMIN });
  assert.equal((await store.softDelete(link.id, 'dup', LOCAL_ADMIN)).note, 'turn 3');
});

test('the Discord post carries a nonce derived from the reply ID, the same on every attempt', async () => {
  const discord = fakeDiscord();
  const harness = await startHarness({ evidence: evidence(discord.delivery) });
  try {
    const token = await login(harness);
    discord.state.failure = new Error('timeout');
    const failed = (await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) })).json().reply;
    discord.state.failure = null;
    await call(harness.port, `${replies}/${failed.id}/retry`, { method: 'POST', token, body: json({}) });
    assert.equal(discord.posted.length, 1);
    assert.equal(discord.posted[0]!.nonce, replyNonce(failed.id));
    assert.ok(discord.posted[0]!.nonce.length <= 25 && discord.posted[0]!.nonce.length > 0);
  } finally { await harness.stop(); }
});

test('a late finish from an older attempt cannot overwrite a newer one, and is not an error', async () => {
  let clock = 5_000_000;
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit, () => clock);
  const first = await store.createReply({ eventId, matchId: 'M1', body: 'hello', audience: 'players', author: 'local-admin', actor: LOCAL_ADMIN });
  clock += EVIDENCE_REPLY_STALE_MS + 1;                       // the first send is still queued, but reads as failed
  const second = await store.claimReplyRetry(first.id, LOCAL_ADMIN);
  assert.notEqual(second.attempt, first.attempt);
  const late = await store.finishReplyDelivery(first.id, { error: 'late failure' }, LOCAL_ADMIN, first.attempt);
  assert.equal(late.status, 'pending', 'the newer attempt is untouched');
  assert.equal((await store.getReply(first.id))?.deliveryError, null);
  const done = await store.finishReplyDelivery(first.id, { messageId: '900000000000000001' }, LOCAL_ADMIN, second.attempt);
  assert.equal(done.status, 'delivered');
  // Nothing finishes a delivered reply again, whichever attempt reports.
  assert.equal((await store.finishReplyDelivery(first.id, { error: 'again' }, LOCAL_ADMIN, second.attempt)).status, 'delivered');
});

test('if recording the outcome fails once, the delivery result is recorded on the second try', async () => {
  const discord = fakeDiscord();
  const options = evidence(discord.delivery);
  const finish = options.store.finishReplyDelivery.bind(options.store);
  let calls = 0;
  options.store.finishReplyDelivery = async (...args) => { calls += 1; if (calls === 1) throw new Error('db blip'); return finish(...args); };
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const reply = (await call(harness.port, replies, { method: 'POST', token, body: json({ body: 'hi', audience: 'players' }) })).json().reply;
    assert.equal(reply.status, 'delivered');
    assert.equal(discord.posted.length, 1);
  } finally { await harness.stop(); }
});
