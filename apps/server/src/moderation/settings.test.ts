import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS, MODERATION_LIMITS, VOICE_SENSITIVITY_PRESETS, type ModerationSettingsBodyDto } from '@tcg-live/core';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OpsInputError } from '../ops/errors.js';
import { changedSections, defaultModerationSettings, MemoryModerationSettingsStore, ModerationVersionConflictError,
  parseModerationSettings } from './settings.js';

const guild = '123456789012345678';
const admin = { kind: 'admin' as const, id: 'local-admin' };
const defaults = (): ModerationSettingsBodyDto => structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto;

test('defaults follow the decisions: judge-call recording, 30-day retention, loudness flag-only and off', () => {
  const value = defaultModerationSettings(guild);
  assert.equal(value.version, 0);
  assert.equal(value.recording.mode, 'judge-call');
  assert.equal(value.retention.days, 30);
  assert.equal(value.voice.sensitivity, 'medium');
  assert.deepEqual(value.text.preset.presets, { profanity: true, sexual: true, slurs: true });
  assert.equal(value.noticeText, null);
  assert.deepEqual(parseModerationSettings(defaults()), defaults(), 'defaults validate unchanged');
});

test('named sensitivity presets own threshold and sustain; custom keeps advanced values', () => {
  const input = defaults();
  input.voice = { ...input.voice, sensitivity: 'high', thresholdDbfs: -1, sustainMs: 3000, cooldownMs: 5000 };
  const high = parseModerationSettings(input).voice;
  assert.equal(high.thresholdDbfs, VOICE_SENSITIVITY_PRESETS.high.thresholdDbfs);
  assert.equal(high.sustainMs, VOICE_SENSITIVITY_PRESETS.high.sustainMs);
  assert.equal(high.cooldownMs, 5000);
  input.voice.sensitivity = 'custom';
  assert.deepEqual([parseModerationSettings(input).voice.thresholdDbfs, parseModerationSettings(input).voice.sustainMs], [-1, 3000]);
});

test('word lists are trimmed and de-duplicated case-insensitively; limits are enforced', () => {
  const input = defaults();
  input.text.customLists = [{ id: 'local', name: ' House rules ', enabled: true, words: [' Noob ', 'noob', 'ez'], regexPatterns: [],
    allowList: ['scunthorpe'], action: 'timeout', timeoutSeconds: 600 }];
  const list = parseModerationSettings(input).text.customLists[0]!;
  assert.deepEqual(list.words, ['Noob', 'ez']);
  assert.equal(list.name, 'House rules');
  input.text.customLists[0]!.words = Array.from({ length: MODERATION_LIMITS.wordsPerList + 1 }, (_, i) => `w${i}`);
  assert.throws(() => parseModerationSettings(input), OpsInputError);
});

test('strict validation refuses unknown fields, bad enums, out-of-range numbers and impossible AutoMod actions', () => {
  const cases: Array<(value: ModerationSettingsBodyDto & Record<string, unknown>) => void> = [
    value => { value.extra = true; },
    value => { (value.voice as unknown as Record<string, unknown>).autoMute = true; },
    value => { (value.recording as { mode: string }).mode = 'video'; },
    value => { value.retention.days = 0; },
    value => { value.retention.days = 366; },
    value => { value.retention.days = 7.5; },
    value => { value.voice.thresholdDbfs = 5; value.voice.sensitivity = 'custom'; },
    value => { value.voice.cooldownMs = 1000; },
    value => { (value.text.preset as { action: string }).action = 'timeout'; },
    value => { value.text.alertChannelId = '12'; },
    value => { value.text.exemptRoleIds = Array.from({ length: 21 }, (_, i) => `1234567890123456${10 + i}`); },
    value => { value.noticeText = ''; },
    value => { value.noticeText = 'x\u0000'; },
    value => { value.text.customLists = [{ id: 'a', name: 'A', enabled: true, words: [], regexPatterns: [], allowList: [], action: 'flag', timeoutSeconds: 10 }]; },
    value => { const list = { id: 'a', name: 'A', enabled: true, words: [], regexPatterns: [], allowList: [], action: 'flag' as const, timeoutSeconds: 60 };
      value.text.customLists = [list, { ...list }]; }
  ];
  for (const [index, mutate] of cases.entries()) {
    const value = defaults() as ModerationSettingsBodyDto & Record<string, unknown>;
    mutate(value);
    assert.throws(() => parseModerationSettings(value), OpsInputError, `case ${index}`);
  }
  for (const days of [7, 30, null, 1, 365]) assert.equal(parseModerationSettings({ ...defaults(), retention: { days } }).retention.days, days);
});

test('saves use optimistic versions and audit only the changed section names', async () => {
  const audit = new MemoryOpsAuditStore(() => 1_000);
  const store = new MemoryModerationSettingsStore(audit, () => 2_000);
  const next = defaults();
  next.recording.mode = 'always';
  next.text.customLists = [{ id: 'x', name: 'X', enabled: true, words: ['secretword'], regexPatterns: [], allowList: [], action: 'block', timeoutSeconds: 60 }];
  const saved = await store.put(guild, 0, next, admin);
  assert.equal(saved.version, 1);
  assert.equal(saved.updatedAtMs, 2_000);
  await assert.rejects(store.put(guild, 0, next, admin), (error: unknown) =>
    error instanceof ModerationVersionConflictError && error.current.version === 1 && error.current.recording.mode === 'always');
  await assert.rejects(store.put(guild, 1, { ...next, recording: { mode: 'sometimes' } }, admin), OpsInputError);
  assert.equal((await store.get(guild)).version, 1);
  assert.equal(audit.entries.length, 1);
  assert.deepEqual(audit.entries[0]!.payload, { version: 1, sections: ['text', 'recording'] });
  assert.doesNotMatch(JSON.stringify(audit.entries), /secretword/);
  assert.deepEqual(changedSections(defaults(), defaults()), []);
  await assert.rejects(store.get('not-a-guild'), OpsInputError);
});
