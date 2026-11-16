import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import type { EvidenceRouteSeams } from './routes.js';
import { MemoryEvidenceStore } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const base = `/api/v1/events/${eventId}/matches/M1/evidence`;
const json = (body: unknown) => JSON.stringify(body);

function evidence(seams?: EvidenceRouteSeams) {
  const audit = new MemoryOpsAuditStore();
  return { audit, store: new MemoryEvidenceStore(audit), ...(seams ? { seams } : {}) };
}

test('evidence reads need evidence.read and changes need evidence.manage', async () => {
  const harness = await startHarness({ evidence: evidence() }, { capabilities: ['dashboard.read'] });
  try {
    assert.equal((await call(harness.port, base)).status, 401);
    const token = await login(harness);
    assert.equal((await call(harness.port, '/api/v1/session', { token })).json().evidence, true);
    assert.equal((await call(harness.port, base, { token })).status, 403);
    assert.equal((await call(harness.port, base, { method: 'POST', token, body: json({ url: 'https://x.y' }) })).status, 403);
  } finally { await harness.stop(); }
  const reader = await startHarness({ evidence: evidence() }, { capabilities: ['dashboard.read', 'evidence.read'] });
  try {
    const token = await login(reader);
    assert.equal((await call(reader.port, base, { token })).status, 200);
    assert.equal((await call(reader.port, base, { method: 'POST', token, body: json({ url: 'https://x.y' }) })).status, 403);
    assert.equal((await call(reader.port, `/api/v1/evidence/${eventId}`, { method: 'PATCH', token, body: json({ hold: true }) })).status, 403);
  } finally { await reader.stop(); }
});

test('link evidence, hold and delete with a required reason; every change is audited', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    assert.deepEqual((await call(harness.port, base, { token })).json(), { eventId, matchId: 'M1', items: [] });
    assert.equal((await call(harness.port, base, { method: 'POST', token, body: json({ url: 'http://insecure.example/x' }) })).status, 400);
    assert.equal((await call(harness.port, base, { method: 'POST', token, body: json({ url: 'https://x.y', extra: 1 }) })).status, 400);
    assert.equal((await call(harness.port, `/api/v1/events/../matches/M1/evidence`, { token })).status, 400);
    assert.equal((await call(harness.port, `/api/v1/events/${eventId}/matches/Z9/evidence`, { token })).status, 400);
    const created = await call(harness.port, base, { method: 'POST', token, body: json({ url: 'https://youtu.be/abc', note: 'turn 3' }) });
    assert.equal(created.status, 201, created.text);
    const item = created.json().item;
    assert.equal(item.kind, 'link');
    assert.equal(item.submittedBy, 'local-admin');
    assert.equal('storagePath' in item, false);
    const held = await call(harness.port, `/api/v1/evidence/${item.id}`, { method: 'PATCH', token, body: json({ hold: true }) });
    assert.equal(held.json().item.hold, true);
    assert.equal((await call(harness.port, `/api/v1/evidence/${item.id}`, { method: 'DELETE', token, body: json({ reason: 'dup' }) })).status, 409);
    await call(harness.port, `/api/v1/evidence/${item.id}`, { method: 'PATCH', token, body: json({ hold: false }) });
    assert.equal((await call(harness.port, `/api/v1/evidence/${item.id}`, { method: 'DELETE', token, body: json({}) })).status, 400);
    const deleted = await call(harness.port, `/api/v1/evidence/${item.id}`, { method: 'DELETE', token, body: json({ reason: 'wrong match' }) });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json().item.status, 'deleted');
    assert.equal((await call(harness.port, '/api/v1/evidence/22222222-2222-4222-8222-222222222222', { method: 'PATCH', token,
      body: json({ hold: true }) })).status, 404);
    assert.deepEqual(options.audit.entries.map(entry => entry.kind),
      ['evidence.submitted', 'evidence.hold', 'evidence.hold', 'evidence.deleted']);
  } finally { await harness.stop(); }
});

test('upload, playback and media are 501 seams until implemented', async () => {
  const harness = await startHarness({ evidence: evidence() });
  try {
    const token = await login(harness);
    const upload = await call(harness.port, base, { method: 'POST', token, body: 'binary',
      headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(upload.status, 501);
    assert.equal((await call(harness.port, `/api/v1/evidence/${eventId}/playback`, { method: 'POST', token })).status, 501);
    const ticket = 'a'.repeat(43);
    assert.equal((await call(harness.port, `/api/v1/media/${ticket}`)).status, 501, 'public route: no bearer needed');
    assert.equal((await call(harness.port, `/api/v1/media/${ticket}`, { method: 'HEAD' })).status, 501);
    assert.equal((await call(harness.port, '/api/v1/media/short')).status, 404);
  } finally { await harness.stop(); }
});

test('playback seam receives a session liveness check that ends at logout, and views are audited', async () => {
  let live: (() => boolean) | undefined;
  const options = evidence({
    async playback(context) { live = context.sessionLive; return { url: `/api/v1/media/${'t'.repeat(43)}`, expiresAtMs: 1 }; },
    async upload(context) {
      context.request.resume();
      const pending = await context.store.createPendingUpload({ eventId: context.eventId, matchId: context.matchId, kind: 'upload',
        extension: 'mp4', source: 'web', submittedBy: 'local-admin', actor: context.actor, note: context.note });
      return context.store.markStored(pending.id, { byteSize: 6, sha256: 'c'.repeat(64) }, context.actor);
    }
  });
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const upload = await call(harness.port, `${base}?note=clip`, { method: 'POST', token, body: 'binary', headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(upload.status, 201, upload.text);
    const id = upload.json().item.id;
    assert.equal(upload.json().item.note, 'clip');
    const ticket = await call(harness.port, `/api/v1/evidence/${id}/playback`, { method: 'POST', token });
    assert.equal(ticket.status, 200, ticket.text);
    assert.equal(live?.(), true);
    await call(harness.port, '/api/v1/session', { method: 'DELETE', token });
    assert.equal(live?.(), false, 'tickets die with their session');
    assert.deepEqual(options.audit.entries.map(entry => entry.kind), ['evidence.submitted', 'evidence.viewed']);
  } finally { await harness.stop(); }
});

test('an evidence POST without a Content-Type is refused with 415, not read as JSON', async () => {
  const options = evidence();
  const harness = await startHarness({ evidence: options });
  try {
    const token = await login(harness);
    const bare = await call(harness.port, base, { method: 'POST', token, headers: { 'Content-Length': '0' } });
    assert.equal(bare.status, 415, bare.text);
    assert.equal(options.store.records.size, 0);
  } finally { await harness.stop(); }
});

test('the operator seated in a match cannot reply to it or hold or delete its evidence; another match is fine', async () => {
  const options = { ...evidence(), matchConflict: async (_event: string, matchId: string) => matchId === 'M1' };
  const harness = await startHarness({ evidence: options });
  const m2 = `/api/v1/events/${eventId}/matches/M2/evidence`;
  try {
    const token = await login(harness);
    const own = await call(harness.port, base, { method: 'POST', token, body: json({ url: 'https://youtu.be/own' }) });
    assert.equal(own.status, 201, 'adding evidence is not a ruling');
    const other = await call(harness.port, m2, { method: 'POST', token, body: json({ url: 'https://youtu.be/other' }) });
    const ownId = own.json().item.id;
    const otherId = other.json().item.id;
    const refused = await call(harness.port, `${base}/replies`, { method: 'POST', token, body: json({ body: 'hi', audience: 'staff' }) });
    assert.equal(refused.status, 422);
    assert.equal(refused.json().error.code, 'rule');
    assert.match(refused.json().error.message, /You are playing in M1, so another organizer or judge must rule on it\. Add a TCG Judge in Admin tools > Settings > Tournament roles\.$/);
    assert.equal((await call(harness.port, `${base}/replies`, { token })).json().replies.length, 0, 'nothing was stored');
    assert.equal((await call(harness.port, `/api/v1/evidence/${ownId}`, { method: 'PATCH', token, body: json({ hold: true }) })).status, 422);
    assert.equal((await call(harness.port, `/api/v1/evidence/${ownId}`, { method: 'DELETE', token, body: json({ reason: 'dup' }) })).status, 422);
    assert.equal((await call(harness.port, `${base}/replies/22222222-2222-4222-8222-222222222222/retry`, { method: 'POST', token, body: json({}) })).status, 422,
      'retrying a reply on the operator own match is refused too');
    assert.equal((await call(harness.port, `${m2}/replies`, { method: 'POST', token, body: json({ body: 'hi', audience: 'staff' }) })).status, 201);
    assert.equal((await call(harness.port, `/api/v1/evidence/${otherId}`, { method: 'PATCH', token, body: json({ hold: true }) })).status, 200);
  } finally { await harness.stop(); }
});
