// Demo-only sample data for the evidence and moderation screens (`npm run admin:demo`): once each demo event
// has matches, M1 gets a keyword flag, a volume flag, an evidence link and a short generated (silent) Ogg
// voice track for seat A, so the Flags tab, the Evidence drawer and the ops audit all have something to show.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EventSnapshotDto } from '@tcg-live/core';
import { LOCAL_ADMIN } from '../ops/audit.js';
import type { EvidenceStore } from '../evidence/store.js';
import type { ModerationFlagStore } from '../moderation/flags.js';
import { OggOpusWriter } from '../voice/ogg-writer.js';
import type { AdminRuntime } from './runtime-types.js';

/** A 20 ms Opus silence frame (TOC 0xF8: CELT FB 20 ms, mono). */
const SILENCE = new Uint8Array([0xf8, 0xff, 0xfe]);
const VOICE_SECONDS = 6;

/** A small valid Ogg Opus file of silence. */
export function silentOgg(seconds = VOICE_SECONDS, startMs = 0): { bytes: Buffer; durationMs: number } {
  const pages: Buffer[] = [];
  const writer = new OggOpusWriter(page => pages.push(page), { startMs, channels: 1, serial: 0x7c61 });
  for (let index = 0; index < seconds * 50; index += 1) writer.writePacket(SILENCE, startMs + index * 20);
  writer.close();
  return { bytes: Buffer.concat(pages), durationMs: Math.round(writer.durationMs) };
}

export interface DemoSeedTargets {
  guildId: string;
  flags: ModerationFlagStore;
  evidence: EvidenceStore;
  /** Where the demo's evidence seams read files from. */
  evidenceRoot: string;
  now?(): number;
}

export async function seedEventSamples(snapshot: EventSnapshotDto, targets: DemoSeedTargets): Promise<boolean> {
  const match = snapshot.matches[0];
  if (!match) return false;
  const now = targets.now?.() ?? Date.now();
  const seatA = snapshot.seats[match.seats[0]] ?? null;
  const seatB = snapshot.seats[match.seats[1]] ?? null;
  const base = { guildId: targets.guildId, eventId: snapshot.eventId, matchId: match.id };
  await targets.flags.append({ ...base, kind: 'keyword', userId: seatB, occurredAtMs: now - 90_000,
    detail: { ruleId: null, ruleName: 'TCG Live: blocked words', action: 'block', matchedKeyword: 'scrub', matchedContent: null } });
  await targets.flags.append({ ...base, kind: 'volume', userId: seatA, occurredAtMs: now - 3_000,
    detail: { peakDbfs: -2.4, rmsDbfs: -9.8, sustainedMs: 1400, thresholdDbfs: -12, recordingOffsetMs: 3_000 } });
  await targets.evidence.createLink({ eventId: snapshot.eventId, matchId: match.id, source: 'discord', submittedBy: seatB ?? 'local-admin',
    seat: seatB ? match.seats[1] : null, note: 'Clip of the disputed attack step (demo sample).', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    actor: seatB ? { kind: 'player', id: seatB } : LOCAL_ADMIN });
  const startedAt = now - VOICE_SECONDS * 1000;
  const pending = await targets.evidence.createPendingUpload({ eventId: snapshot.eventId, matchId: match.id, source: 'bot', submittedBy: 'bot',
    kind: 'voice', extension: 'ogg', originalName: `${match.id}-voice-${seatA ?? 'demo'}.ogg`, actor: { kind: 'bot', id: 'bot' },
    ...(seatA ? { recordedUserId: seatA } : {}), recordingStartedAtMs: startedAt });
  const { bytes, durationMs } = silentOgg(VOICE_SECONDS, startedAt);
  const file = join(targets.evidenceRoot, pending.storagePath!);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  await targets.evidence.markStored(pending.id, { byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'audio/ogg', durationMs }, { kind: 'bot', id: 'bot' });
  return true;
}

/** Seeds every demo event once, as soon as it has matches. Returns the unsubscribe. Errors never reach the demo. */
export function seedDemoOps(runtime: Pick<AdminRuntime, 'subscribe' | 'snapshot'>, targets: DemoSeedTargets): () => void {
  const done = new Set<string>();
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const snapshot = await runtime.snapshot();
      if (!done.has(snapshot.eventId) && snapshot.matches.length > 0) {
        done.add(snapshot.eventId);
        await seedEventSamples(snapshot, targets);
      }
    } catch { /* Sample data is a nicety. */ } finally { busy = false; }
  };
  const unsubscribe = runtime.subscribe(() => { void check(); });
  void check();
  return unsubscribe;
}
