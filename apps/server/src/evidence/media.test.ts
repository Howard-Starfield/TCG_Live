import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { createEvidenceSeams } from './seams.js';
import { MemoryEvidenceStore } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const base = `/api/v1/events/${eventId}/matches/M1/evidence`;
const MP4 = String.fromCharCode(0, 0, 0, 0x18) + 'ftypisom' + String.fromCharCode(0, 0, 2, 0) + 'isomiso2avc1mp41';
const GIB = 1024 ** 3;

async function setup(adminMaxBytes = 10_000) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-http-'));
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const bundle = createEvidenceSeams({ root, adminMaxBytes, freeBytes: async () => 100 * GIB });
  const harness = await startHarness({ evidence: { store, audit, seams: bundle.seams } });
  return { root, audit, store, harness, bundle, async stop() { await harness.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('dashboard upload, playback ticket, and ranged media with the required headers', async () => {
  const s = await setup();
  try {
    const token = await login(s.harness);
    const body = MP4 + 'x'.repeat(968);   // 1000 bytes
    const upload = await call(s.harness.port, `${base}?note=judge%20view`, { method: 'POST', token, body,
      headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(upload.status, 201, upload.text);
    const item = upload.json().item;
    assert.equal(item.byteSize, 1000);
    assert.equal(item.note, 'judge view');
    assert.equal(item.submittedBy, 'local-admin');
    assert.equal('storagePath' in item, false);

    const issued = await call(s.harness.port, `/api/v1/evidence/${item.id}/playback`, { method: 'POST', token });
    assert.equal(issued.status, 200, issued.text);
    const url: string = issued.json().url;
    assert.match(url, /^\/api\/v1\/media\/[A-Za-z0-9_-]{43}$/);

    const full = await call(s.harness.port, url);
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'video/mp4');
    assert.equal(full.headers['content-length'], '1000');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.equal(full.headers['x-content-type-options'], 'nosniff');
    assert.equal(full.headers['cache-control'], 'no-store');
    assert.match(String(full.headers['content-disposition']), /^inline; filename="[0-9a-f-]{36}\.mp4"$/);
    assert.equal(full.text, body);

    const partial = await call(s.harness.port, url, { headers: { Range: 'bytes=4-11' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 4-11/1000');
    assert.equal(partial.text, 'ftypisom');
    const suffix = await call(s.harness.port, url, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], 'bytes 997-999/1000');
    const open = await call(s.harness.port, url, { headers: { Range: 'bytes=990-' } });
    assert.equal(open.headers['content-length'], '10');
    const multi = await call(s.harness.port, url, { headers: { Range: 'bytes=0-1,4-5' } });
    assert.equal(multi.status, 200);
    const unsatisfiable = await call(s.harness.port, url, { headers: { Range: 'bytes=1000-' } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers['content-range'], 'bytes */1000');
    const head = await call(s.harness.port, url, { method: 'HEAD', headers: { Range: 'bytes=0-99' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers['content-length'], '100');
    assert.equal(head.text, '');
    const download = await call(s.harness.port, `${url}?download=1`);
    assert.match(String(download.headers['content-disposition']), /^attachment; /);
    assert.equal((await call(s.harness.port, `${url}?other=1`)).status, 400);
    assert.equal((await call(s.harness.port, url, { headers: { Host: 'evil.example' } })).status, 403, 'Host check still applies');
    assert.equal((await call(s.harness.port, `/api/v1/media/${'A'.repeat(43)}`)).status, 404, 'unknown ticket');

    // Deleting the evidence removes the file and revokes its tickets.
    const deleted = await call(s.harness.port, `/api/v1/evidence/${item.id}`, { method: 'DELETE', token, body: JSON.stringify({ reason: 'dup' }) });
    assert.equal(deleted.status, 200);
    assert.equal((await call(s.harness.port, url)).status, 404);
    assert.deepEqual(await readdir(path.join(s.root, eventId)), []);
    assert.deepEqual(s.audit.entries.map(entry => entry.kind), ['evidence.submitted', 'evidence.viewed', 'evidence.deleted']);
  } finally { await s.stop(); }
});

test('tickets stop working when the issuing session signs out', async () => {
  const s = await setup();
  try {
    const token = await login(s.harness);
    const item = (await call(s.harness.port, base, { method: 'POST', token, body: MP4, headers: { 'Content-Type': 'video/mp4' } })).json().item;
    const url = (await call(s.harness.port, `/api/v1/evidence/${item.id}/playback`, { method: 'POST', token })).json().url;
    assert.equal((await call(s.harness.port, url)).status, 200);
    await call(s.harness.port, '/api/v1/session', { method: 'DELETE', token });
    assert.equal((await call(s.harness.port, url)).status, 404);
  } finally { await s.stop(); }
});

test('upload refusals: over the admin cap (413), unsupported type (415), and no temp files left', async () => {
  const s = await setup(100);
  try {
    const token = await login(s.harness);
    const big = await call(s.harness.port, base, { method: 'POST', token, body: MP4 + 'x'.repeat(200), headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(big.status, 413, big.text);
    const pdf = await call(s.harness.port, base, { method: 'POST', token, body: '%PDF-1.7', headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(pdf.status, 415, pdf.text);
    assert.deepEqual(await readdir(path.join(s.root, '.tmp')), []);
    assert.equal(s.store.records.size, 0);
  } finally { await s.stop(); }
});
