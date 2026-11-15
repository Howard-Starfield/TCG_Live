import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from './admin-contract.js';
import { EVIDENCE_FILE_TYPES, isEvidenceFileExtension } from './evidence-contract.js';
import { DEFAULT_MODERATION_SETTINGS, MODERATION_LIMITS as L, RETENTION_PRESET_DAYS, VOICE_SENSITIVITY_PRESETS } from './moderation-contract.js';

test('evidence and moderation capabilities follow the existing capability list', () => {
  for (const capability of ['evidence.read', 'evidence.manage', 'moderation.manage'] as const)
    assert.ok(CAPABILITIES.includes(capability));
});

test('defaults and presets sit inside the published limits', () => {
  const voice = DEFAULT_MODERATION_SETTINGS.voice;
  assert.equal(DEFAULT_MODERATION_SETTINGS.recording.mode, 'judge-call');
  assert.equal(DEFAULT_MODERATION_SETTINGS.retention.days, 30);
  assert.deepEqual([...RETENTION_PRESET_DAYS], [7, 30, null]);
  for (const preset of [...Object.values(VOICE_SENSITIVITY_PRESETS), voice]) {
    assert.ok(preset.thresholdDbfs >= L.thresholdDbfsMin && preset.thresholdDbfs <= L.thresholdDbfsMax);
    assert.ok(preset.sustainMs >= L.sustainMsMin && preset.sustainMs <= L.sustainMsMax);
  }
  assert.ok(voice.cooldownMs >= L.cooldownMsMin && voice.cooldownMs <= L.cooldownMsMax);
  assert.ok(DEFAULT_MODERATION_SETTINGS.text.blockMessage.length <= L.blockMessageLength);
  assert.equal(EVIDENCE_FILE_TYPES.mkv.playable, false);
  assert.equal(isEvidenceFileExtension('mp4'), true);
  assert.equal(isEvidenceFileExtension('toString'), false);
});
