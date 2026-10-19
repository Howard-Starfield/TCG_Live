import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatClock, remainingMsAt } from './clock.js';
import { formatStreamId, parseStreamId } from './admin-contract.js';
import { FIXTURE_BOOT_ID, FIXTURE_EVENT_ID, FIXTURE_NOW_MS, liveDispute, liveInterrupted, auditTimeline } from './fixtures.js';

test('remainingMsAt counts down only while running', () => {
  const running = liveDispute.matches[0]!.clock;
  assert.equal(remainingMsAt(running, running.runningSinceMs!), running.remainingMs);
  assert.equal(remainingMsAt(running, running.runningSinceMs! + 61_000), running.remainingMs - 61_000);
  assert.equal(remainingMsAt(running, running.runningSinceMs! - 5_000), running.remainingMs, 'never counts up');
  assert.equal(remainingMsAt(running, running.runningSinceMs! + running.remainingMs * 2), 0);
  const interrupted = liveInterrupted.matches[0]!.clock;
  assert.equal(remainingMsAt(interrupted, FIXTURE_NOW_MS + 600_000), interrupted.remainingMs);
  const paused = liveDispute.matches[1]!.clock;
  assert.equal(remainingMsAt(paused, FIXTURE_NOW_MS + 600_000), paused.remainingMs);
});

test('formatClock rounds up and pads seconds', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(1), '0:01');
  assert.equal(formatClock(61_000), '1:01');
  assert.equal(formatClock(3_000_000), '50:00');
});

test('stream IDs round-trip and reject malformed input', () => {
  const cursor = { bootId: FIXTURE_BOOT_ID, eventId: FIXTURE_EVENT_ID, version: 17, panelRevision: 2 };
  assert.deepEqual(parseStreamId(formatStreamId(cursor)), cursor);
  for (const bad of [null, '', 'x', 'a.b.c', 'a.b.1.x', 'a.b.-1.0', 'a b.c.1.1']) assert.equal(parseStreamId(bad), null);
});

test('fixture timeline is contiguous and ends at the liveDispute version', () => {
  auditTimeline.forEach((entry, index) => assert.equal(entry.sequence, index + 1));
  assert.equal(auditTimeline.at(-1)!.sequence, liveDispute.version);
  assert.equal(auditTimeline.at(-1)!.occurredAtMs, liveDispute.matches[1]!.judge!.sinceMs);
});
