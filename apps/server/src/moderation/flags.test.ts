import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OpsInputError } from '../ops/errors.js';
import { MemoryModerationFlagStore, normalizeFlag } from './flags.js';

const guild = '123456789012345678';
const user = '223456789012345678';

test('flags validate IDs, clip Discord-provided text and round loudness numbers', () => {
  const keyword = normalizeFlag({ kind: 'keyword', guildId: guild, userId: user, matchId: 'M2',
    detail: { ruleId: null, ruleName: 'TCG Live – custom words', action: 'block', matchedKeyword: 'k'.repeat(80), matchedContent: 'a\u0000b' } }, () => 7);
  assert.equal(keyword.occurredAtMs, 7);
  assert.equal(keyword.kind === 'keyword' && keyword.detail.matchedKeyword?.length, 60);
  assert.equal(keyword.kind === 'keyword' && keyword.detail.matchedContent, 'a b');
  const volume = normalizeFlag({ kind: 'volume', guildId: guild, channelId: user,
    detail: { peakDbfs: -1.234, rmsDbfs: -6.66, sustainedMs: 450, thresholdDbfs: -8 } }, () => 7);
  assert.deepEqual(volume.detail, { peakDbfs: -1.2, rmsDbfs: -6.7, sustainedMs: 450, thresholdDbfs: -8 });
  for (const input of [
    { kind: 'other', guildId: guild, detail: {} },
    { kind: 'volume', guildId: 'x', detail: { peakDbfs: -1, rmsDbfs: -1, sustainedMs: 1, thresholdDbfs: -8 } },
    { kind: 'volume', guildId: guild, matchId: 'X1', detail: { peakDbfs: -1, rmsDbfs: -1, sustainedMs: 1, thresholdDbfs: -8 } },
    { kind: 'volume', guildId: guild, detail: { peakDbfs: 3, rmsDbfs: -1, sustainedMs: 1, thresholdDbfs: -8 } },
    { kind: 'keyword', guildId: guild, detail: { ruleId: null, ruleName: 'r', action: 'mute', matchedKeyword: null, matchedContent: null } }
  ]) assert.throws(() => normalizeFlag(input as never, () => 1), OpsInputError);
});

test('each flag writes its ops-audit row and pages by after cursor per guild', async () => {
  const audit = new MemoryOpsAuditStore(() => 1);
  const flags = new MemoryModerationFlagStore(audit, () => 1);
  const volume = { peakDbfs: -2, rmsDbfs: -5, sustainedMs: 500, thresholdDbfs: -8 };
  await flags.append({ kind: 'volume', guildId: guild, userId: user, detail: volume });
  await flags.append({ kind: 'keyword', guildId: guild, detail: { ruleId: null, ruleName: 'preset', action: 'flag', matchedKeyword: null, matchedContent: null } });
  await flags.append({ kind: 'volume', guildId: '323456789012345678', detail: volume });
  const page = await flags.list(guild, { limit: 1 });
  assert.deepEqual(page.flags.map(flag => flag.id), [1]);
  assert.deepEqual((await flags.list(guild, { after: page.nextAfter })).flags.map(flag => flag.kind), ['keyword']);
  assert.deepEqual(audit.entries.map(entry => entry.kind), ['voice.spike', 'automod.executed', 'voice.spike']);
  assert.equal(audit.entries[0]!.payload.flagId, 1);
});
