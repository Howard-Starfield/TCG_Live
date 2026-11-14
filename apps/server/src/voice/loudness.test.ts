import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS, VOICE_SENSITIVITY_PRESETS } from '@tcg-live/core';
import { FRAME_MS, frameLevels, LoudnessDetector, loudnessConfig, sineFrame, type LoudnessSpike } from './loudness.js';

const medium = loudnessConfig(DEFAULT_MODERATION_SETTINGS.voice);

function play(detector: LoudnessDetector, userId: string, peakDbfs: number, fromMs: number, durationMs: number) {
  for (let at = fromMs, sample = 0; at < fromMs + durationMs; at += FRAME_MS, sample += 960)
    detector.pushFrame(userId, sineFrame(peakDbfs, 440, sample), at);
}

test('frame levels: a sine peak and its RMS are 3 dB apart; digital silence hits the floor', () => {
  const levels = frameLevels(sineFrame(-3));
  assert.ok(Math.abs(levels.peakDbfs - -3) < 0.05, `peak ${levels.peakDbfs}`);
  assert.ok(Math.abs(levels.rmsDbfs - -6.01) < 0.1, `rms ${levels.rmsDbfs}`);
  assert.equal(frameLevels(new Int16Array(1920)).rmsDbfs, -120);
});

test('presets fill threshold and sustain from the contract; custom keeps the advanced values', () => {
  assert.deepEqual(loudnessConfig({ ...DEFAULT_MODERATION_SETTINGS.voice, sensitivity: 'high' }).thresholdDbfs, VOICE_SENSITIVITY_PRESETS.high.thresholdDbfs);
  assert.equal(loudnessConfig({ ...DEFAULT_MODERATION_SETTINGS.voice, sensitivity: 'low' }).sustainMs, VOICE_SENSITIVITY_PRESETS.low.sustainMs);
  const custom = loudnessConfig({ sensitivity: 'custom', thresholdDbfs: -50, sustainMs: 150, cooldownMs: 1 });
  assert.deepEqual([custom.thresholdDbfs, custom.sustainMs, custom.cooldownMs], [-30, 150, 5000]);
});

test('a -3 dBFS sine for 500 ms triggers once; -20 dBFS does not', () => {
  const spikes: LoudnessSpike[] = [];
  const detector = new LoudnessDetector(medium, spike => spikes.push(spike));
  play(detector, 'loud', -3, 1_000, 500);
  play(detector, 'quiet', -20, 1_000, 2_000);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0]!.userId, 'loud');
  assert.equal(spikes[0]!.startedAtMs, 1_000);
  assert.ok(spikes[0]!.durationMs >= medium.sustainMs);
  assert.ok(spikes[0]!.peakDbfs <= -2.9 && spikes[0]!.peakDbfs >= -3.1);
});

test('sustain is respected: a burst shorter than the sustain time never fires', () => {
  const spikes: LoudnessSpike[] = [];
  const detector = new LoudnessDetector(medium, spike => spikes.push(spike));
  play(detector, 'u', -3, 0, medium.sustainMs - 60);
  play(detector, 'u', -40, medium.sustainMs - 60, 200);
  play(detector, 'u', -3, 2_000, medium.sustainMs - 60);
  assert.equal(spikes.length, 0);
});

test('cooldown suppresses repeats per user, and frees after the cooldown', () => {
  const spikes: LoudnessSpike[] = [];
  const detector = new LoudnessDetector({ ...medium, cooldownMs: 10_000 }, spike => spikes.push(spike));
  play(detector, 'u', -3, 0, 600);
  play(detector, 'u', -3, 2_000, 600);
  play(detector, 'other', -3, 2_000, 600);
  assert.deepEqual(spikes.map(spike => spike.userId), ['u', 'other']);
  play(detector, 'u', -3, 12_000, 600);
  assert.equal(spikes.length, 3);
});

test('a gap in frames (silence) resets the sustain run', () => {
  const spikes: LoudnessSpike[] = [];
  const detector = new LoudnessDetector(medium, spike => spikes.push(spike));
  play(detector, 'u', -3, 0, 300);
  play(detector, 'u', -3, 1_000, 300);
  assert.equal(spikes.length, 0);
});
