import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryOpsAuditStore, normalizeOpsAudit, MAX_OPS_PAYLOAD_BYTES } from './audit.js';
import { mapOpsError, OpsConflictError, OpsInputError, OpsNotFoundError } from './errors.js';
import { HttpError } from '../admin/http/respond.js';
import { RuleError } from '../rehearsal/domain.js';

const actor = { kind: 'admin' as const, id: 'local-admin' };
const eventId = '11111111-1111-4111-8111-111111111111';

test('audit entries are validated, never carry credential-named keys, and stay small', () => {
  const now = () => 5;
  assert.equal(normalizeOpsAudit({ kind: 'evidence.hold', actor, eventId: eventId.toUpperCase() }, now).eventId, eventId);
  for (const input of [
    { kind: 'evidence.unknown', actor },
    { kind: 'evidence.hold', actor: { kind: 'robot', id: 'x' } },
    { kind: 'evidence.hold', actor: { kind: 'admin', id: '' } },
    { kind: 'evidence.hold', actor, eventId: '../x' },
    { kind: 'evidence.hold', actor, guildId: '12' },
    { kind: 'moderation.voice_bot.added', actor, payload: { token: 'x' } },
    { kind: 'moderation.voice_bot.added', actor, payload: { nested: [{ botToken: 'x' }] } },
    { kind: 'evidence.hold', actor, payload: { blob: 'x'.repeat(MAX_OPS_PAYLOAD_BYTES) } }
  ]) assert.throws(() => normalizeOpsAudit(input as never, now), OpsInputError, JSON.stringify(input).slice(0, 80));
});

test('memory audit pages oldest first with an after cursor and an event filter', async () => {
  const store = new MemoryOpsAuditStore(() => 10);
  for (let i = 0; i < 5; i++) await store.append({ kind: 'evidence.viewed', actor, eventId: i % 2 ? eventId : null });
  const first = await store.list({ limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.id), [1, 2]);
  assert.equal(first.nextAfter, 2);
  assert.deepEqual((await store.list({ after: first.nextAfter })).entries.map(entry => entry.id), [3, 4, 5]);
  assert.deepEqual((await store.list({ eventId })).entries.map(entry => entry.id), [2, 4]);
  assert.equal((await store.list({ after: 99 })).nextAfter, 99);
  await assert.rejects(store.list({ limit: 0 }), OpsInputError);
});

test('store errors map to safe HTTP errors; outages are 503 and bugs propagate', () => {
  const status = (error: unknown) => { try { mapOpsError(error, 'down'); } catch (mapped) { return mapped; } };
  assert.equal((status(new OpsInputError('bad')) as HttpError).status, 400);
  assert.equal((status(new OpsNotFoundError('gone')) as HttpError).status, 404);
  assert.equal((status(new OpsConflictError('held')) as HttpError).status, 409);
  assert.equal((status(Object.assign(new Error('fk'), { code: '23503' })) as HttpError).status, 404);
  assert.equal((status(new Error('Rehearsal database operation failed.', { cause: Object.assign(new Error('fk'), { code: '23503' }) })) as HttpError).status, 404);
  const outage = status(new RuleError('not set up')) as HttpError;
  assert.equal(outage.status, 503);
  assert.equal(outage.message, 'down');
  const bug = new TypeError('x');
  assert.equal(status(bug), bug);
});
