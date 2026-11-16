import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventSnapshotDto } from '@tcg-live/core';
import { MemoryEvidenceStore } from '../evidence/store.js';
import { MemoryModerationFlagStore } from '../moderation/flags.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { readOggPages } from '../voice/ogg-writer.js';
import { seedDemoOps, seedEventSamples, silentOgg } from './demo-seed.js';

const GUILD = '100000000000000001';
const EVENT = '33333333-3333-4333-8333-333333333333';
const A = '910000000000000011';
const B = '910000000000000012';
const snapshot = (matches: number) => ({ eventId: EVENT, seats: { P1: A, P2: B },
  matches: matches ? [{ id: 'M1', seats: ['P1', 'P2'] }] : [] }) as unknown as EventSnapshotDto;

test('silentOgg is a valid Ogg Opus stream of the requested length', () => {
  const { bytes, durationMs } = silentOgg(2, 1000);
  const { pages, validLength } = readOggPages(bytes);
  assert.equal(validLength, bytes.length);
  assert.ok(pages.every(page => page.crcValid));
  assert.equal(durationMs, 2000);
});

test('demo samples: keyword + volume flags, an evidence link and a stored voice file for M1, once per event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcg-demo-seed-'));
  try {
    const audit = new MemoryOpsAuditStore();
    const flags = new MemoryModerationFlagStore(audit);
    const evidence = new MemoryEvidenceStore(audit);
    const targets = { guildId: GUILD, flags, evidence, evidenceRoot: root };
    assert.equal(await seedEventSamples(snapshot(0), targets), false);
    assert.equal(await seedEventSamples(snapshot(1), targets), true);
    assert.deepEqual(flags.flags.map(flag => flag.kind), ['keyword', 'volume']);
    const items = await evidence.list(EVENT, 'M1');
    assert.deepEqual(items.map(item => `${item.kind}:${item.status}`).sort(), ['link:stored', 'voice:stored']);
    const voice = [...evidence.records.values()].find(item => item.kind === 'voice')!;
    assert.equal(voice.recordedUserId, A);
    assert.ok((await readFile(join(root, voice.storagePath!))).length > 0);

    // The subscription seeds a new event once.
    const listeners: Array<() => void> = [];
    const seeded = new MemoryModerationFlagStore(audit);
    let current = snapshot(1);
    const other = { ...snapshot(1), eventId: '44444444-4444-4444-8444-444444444444' } as EventSnapshotDto;
    const stop = seedDemoOps({ snapshot: async () => current, subscribe: listener => { listeners.push(listener as () => void); return () => {}; } },
      { guildId: GUILD, flags: seeded, evidence: new MemoryEvidenceStore(audit), evidenceRoot: root });
    current = other;
    // Poll instead of a fixed 3 x 20 ms: seeding writes a voice file, which can take longer under a loaded test run.
    const deadline = Date.now() + 2_000;
    for (let round = 0; round < 3 || (new Set(seeded.flags.map(flag => flag.eventId)).size < 2 && Date.now() < deadline); round += 1) {
      listeners.forEach(listener => listener());
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    stop();
    assert.deepEqual([...new Set(seeded.flags.map(flag => flag.eventId))].sort(), [EVENT, other.eventId].sort());
    assert.equal(seeded.flags.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
