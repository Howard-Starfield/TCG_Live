// Loudness-spike detection on decoded 48 kHz PCM (pure, no I/O). Each 20 ms frame gives a peak and RMS
// level in dBFS; a short-term window (energy average) smooths RMS; a spike fires when the short-term RMS
// stays at or above the threshold for the sustain time, at most once per cooldown per user.
// dBFS here is relative to a full-scale square wave: a full-scale sine has RMS -3.01 dBFS.
import { MODERATION_LIMITS, VOICE_SENSITIVITY_PRESETS, type VoiceLoudnessSettingsDto } from '@tcg-live/core';

export const FRAME_MS = 20;
export const SAMPLE_RATE = 48_000;
export const DEFAULT_WINDOW_MS = 100;
/** Silence floor: digital zero reports this instead of -Infinity. */
export const DBFS_FLOOR = -120;
const FULL_SCALE = 32_768;

export interface FrameLevels { peakDbfs: number; rmsDbfs: number; /** Mean square of normalized samples. */ energy: number }

export const toDbfs = (linear: number): number => linear <= 0 ? DBFS_FLOOR : Math.max(DBFS_FLOOR, 20 * Math.log10(linear));
const energyToDbfs = (energy: number): number => energy <= 0 ? DBFS_FLOOR : Math.max(DBFS_FLOOR, 10 * Math.log10(energy));

/** Peak and RMS of interleaved signed 16-bit PCM (any channel count: all samples count). */
export function frameLevels(pcm: Int16Array): FrameLevels {
  if (pcm.length === 0) return { peakDbfs: DBFS_FLOOR, rmsDbfs: DBFS_FLOOR, energy: 0 };
  let peak = 0;
  let sum = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const value = Math.abs(pcm[index]!) / FULL_SCALE;
    if (value > peak) peak = value;
    sum += value * value;
  }
  const energy = sum / pcm.length;
  return { peakDbfs: toDbfs(peak), rmsDbfs: energyToDbfs(energy), energy };
}

export interface LoudnessConfig { thresholdDbfs: number; sustainMs: number; cooldownMs: number; windowMs: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Settings → detector numbers. Presets fill threshold and sustain; 'custom' keeps the advanced values. */
export function loudnessConfig(settings: Pick<VoiceLoudnessSettingsDto, 'sensitivity' | 'thresholdDbfs' | 'sustainMs' | 'cooldownMs'>,
  windowMs = DEFAULT_WINDOW_MS): LoudnessConfig {
  const preset = settings.sensitivity === 'custom' ? null : VOICE_SENSITIVITY_PRESETS[settings.sensitivity];
  const limits = MODERATION_LIMITS;
  return {
    thresholdDbfs: clamp(preset?.thresholdDbfs ?? settings.thresholdDbfs, limits.thresholdDbfsMin, limits.thresholdDbfsMax),
    sustainMs: clamp(preset?.sustainMs ?? settings.sustainMs, limits.sustainMsMin, limits.sustainMsMax),
    cooldownMs: clamp(settings.cooldownMs, limits.cooldownMsMin, limits.cooldownMsMax),
    windowMs: Math.max(FRAME_MS, windowMs)
  };
}

export interface LoudnessSpike { userId: string; peakDbfs: number; rmsDbfs: number; startedAtMs: number; durationMs: number }

interface UserState {
  window: Array<{ atMs: number; energy: number }>;
  lastFrameAtMs: number | null;
  aboveSinceMs: number | null;
  peakDbfs: number;
  rmsDbfs: number;
  firedThisRun: boolean;
  lastSpikeAtMs: number | null;
}

/**
 * Per-user detector. Feed one decoded frame per call with its wall-clock start time. A gap in frames
 * (Discord sends nothing while a player is silent) resets the window and the sustain run.
 */
export class LoudnessDetector {
  private readonly users = new Map<string, UserState>();
  constructor(private config: LoudnessConfig, private readonly onSpike: (spike: LoudnessSpike) => void) {}

  configure(config: LoudnessConfig): void { this.config = config; }
  current(): LoudnessConfig { return { ...this.config }; }
  forget(userId: string): void { this.users.delete(userId); }

  /** Returns the spike when this frame triggers one (also delivered to onSpike). */
  pushFrame(userId: string, pcm: Int16Array, atMs: number, frameMs = FRAME_MS): LoudnessSpike | null {
    return this.pushLevels(userId, frameLevels(pcm), atMs, frameMs);
  }

  pushLevels(userId: string, levels: FrameLevels, atMs: number, frameMs = FRAME_MS): LoudnessSpike | null {
    const state = this.users.get(userId) ?? { window: [], lastFrameAtMs: null, aboveSinceMs: null, peakDbfs: DBFS_FLOOR,
      rmsDbfs: DBFS_FLOOR, firedThisRun: false, lastSpikeAtMs: null };
    this.users.set(userId, state);
    // More than two frames missing breaks continuity.
    if (state.lastFrameAtMs !== null && (atMs - state.lastFrameAtMs > frameMs * 3 || atMs < state.lastFrameAtMs)) {
      state.window = [];
      this.resetRun(state);
    }
    state.lastFrameAtMs = atMs;
    state.window.push({ atMs, energy: levels.energy });
    while (state.window.length && state.window[0]!.atMs <= atMs - this.config.windowMs) state.window.shift();
    const shortTerm = energyToDbfs(state.window.reduce((sum, frame) => sum + frame.energy, 0) / state.window.length);
    if (shortTerm < this.config.thresholdDbfs) { this.resetRun(state); return null; }
    if (state.aboveSinceMs === null) state.aboveSinceMs = atMs;
    state.peakDbfs = Math.max(state.peakDbfs, levels.peakDbfs);
    state.rmsDbfs = Math.max(state.rmsDbfs, shortTerm);
    const durationMs = atMs + frameMs - state.aboveSinceMs;
    if (state.firedThisRun || durationMs < this.config.sustainMs) return null;
    if (state.lastSpikeAtMs !== null && atMs - state.lastSpikeAtMs < this.config.cooldownMs) return null;
    state.firedThisRun = true;
    state.lastSpikeAtMs = atMs;
    const spike: LoudnessSpike = { userId, peakDbfs: round(state.peakDbfs), rmsDbfs: round(state.rmsDbfs),
      startedAtMs: state.aboveSinceMs, durationMs };
    this.onSpike(spike);
    return spike;
  }

  private resetRun(state: UserState): void {
    state.aboveSinceMs = null;
    state.firedThisRun = false;
    state.peakDbfs = DBFS_FLOOR;
    state.rmsDbfs = DBFS_FLOOR;
  }
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Test and diagnostics helper: one frame of a sine at `peakDbfs`, interleaved over `channels`. */
export function sineFrame(peakDbfs: number, frequencyHz = 440, startSample = 0, channels = 2, frameMs = FRAME_MS): Int16Array {
  const samples = SAMPLE_RATE * frameMs / 1000;
  const amplitude = Math.round(FULL_SCALE * 10 ** (peakDbfs / 20));
  const out = new Int16Array(samples * channels);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.max(-32_768, Math.min(32_767, Math.round(amplitude * Math.sin(2 * Math.PI * frequencyHz * (startSample + index) / SAMPLE_RATE))));
    for (let channel = 0; channel < channels; channel += 1) out[index * channels + channel] = value;
  }
  return out;
}
