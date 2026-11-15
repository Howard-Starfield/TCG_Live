// "🔴 Audio recording active" on match cards (agent G1). Two sources, merged:
//  - the voice pool's live state (rooms with status 'recording'), read whenever the runtime publishes it;
//  - setMatchRecording(matchId, active), a direct setter the voice feature may call.
// The runtime listens with onRecordingBadgeChange and re-renders the cards when the set changes.
import type { VoicePoolLiveState } from '../voice/pool.js';

const flagged = new Set<string>();
let fromPool = new Set<string>();
const listeners = new Set<() => void>();

function changed(before: string): void {
  if ([...recordingMatchIds()].sort().join() === before) return;
  for (const listener of [...listeners]) { try { listener(); } catch { /* Listeners never affect the voice runtime. */ } }
}
const snapshot = () => [...recordingMatchIds()].sort().join();

/** For the voice feature: mark a match room as being recorded (true) or not (false). */
export function setMatchRecording(matchId: string, active: boolean): void {
  const before = snapshot();
  if (active) flagged.add(matchId); else flagged.delete(matchId);
  changed(before);
}

/** Called by the runtime each time the voice pool publishes its live state (null when voice is off). */
export function syncRecordingFromPool(state: VoicePoolLiveState | null): void {
  const before = snapshot();
  fromPool = new Set((state?.rooms ?? []).filter(room => room.status === 'recording').map(room => room.matchId));
  changed(before);
}

/** Matches whose room is being recorded right now. */
export function recordingMatchIds(): ReadonlySet<string> {
  return new Set([...flagged, ...fromPool]);
}

export function onRecordingBadgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests and runtime restarts. */
export function resetRecordingBadges(): void {
  flagged.clear();
  fromPool = new Set();
  listeners.clear();
}
