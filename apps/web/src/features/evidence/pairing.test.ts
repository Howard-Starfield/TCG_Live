import type { EvidenceItemDto, ModerationFlagDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { flagMarkers, recordingStart, submitterLabel, voicePartner, voicePlayerId } from './EvidenceDrawer';

const START = FIXTURE_NOW_MS - 600_000;
function voice(id: string, userId: string, createdAtMs: number, overrides: Partial<EvidenceItemDto> = {}): EvidenceItemDto {
  return { id, eventId: liveDispute.eventId, matchId: 'M2', proposalRevision: null, kind: 'voice', source: 'bot', submittedBy: 'bot',
    seat: null, note: `Match room audio of player ${userId}`, originalName: `M2-voice-${userId}.ogg`, mime: 'audio/ogg', byteSize: 1000,
    sha256: null, durationMs: 120_000, externalUrl: null, playable: true, status: 'stored', hold: false, createdAtMs,
    deletedAtMs: null, deleteReason: null, ...overrides };
}
const P1 = '300000000000000001';
const P2 = '300000000000000002';

function volume(id: number, occurredAtMs: number, recordingOffsetMs?: number | null): ModerationFlagDto {
  return { id, kind: 'volume', guildId: '100000000000000001', channelId: null, eventId: liveDispute.eventId, matchId: 'M2',
    userId: P1, occurredAtMs, detail: { peakDbfs: -2, rmsDbfs: -6, sustainedMs: 500, thresholdDbfs: -8,
      ...(recordingOffsetMs === undefined ? {} : { recordingOffsetMs }) } };
}

describe('bot voice recordings', () => {
  it('pairs the recorder tracks (seat null, submittedBy bot) by player, not by seat', () => {
    const a = voice('a', P1, START);
    const b = voice('b', P2, START + 40);
    const sameAgain = voice('c', P1, START + 50);
    expect(voicePlayerId(a)).toBe(P1);
    expect(voicePartner([a, b, sameAgain], a)?.id).toBe('b');
    expect(voicePartner([a, sameAgain], a)).toBeNull();
  });

  it('picks the closest track of the other player and ignores ones outside the window', () => {
    const a = voice('a', P1, START);
    const near = voice('near', P2, START + 100);
    const later = voice('later', P2, START + 30_000);
    const far = voice('far', P2, START + 120_000);
    expect(voicePartner([a, later, near], a)?.id).toBe('near');
    expect(voicePartner([a, far], a)).toBeNull();
  });

  it('labels each bot track with its player instead of a generic bot label', () => {
    expect(submitterLabel(liveDispute, voice('a', P1, START))).toContain('(bot recording)');
    expect(submitterLabel(liveDispute, voice('a', P1, START, { originalName: null }))).toBe('Bot recorder');
  });
});

describe('recorder fields', () => {
  it('prefers recordedUserId and recordingStartedAtMs over the file name and createdAtMs', () => {
    const a = voice('a', P1, START + 900, { recordedUserId: P2, recordingStartedAtMs: START, originalName: 'renamed.ogg' });
    const b = voice('b', P1, START + 70_000, { recordedUserId: P1, recordingStartedAtMs: START + 5 });
    expect(voicePlayerId(a)).toBe(P2);
    expect(recordingStart(a)).toBe(START);
    // createdAtMs is 69 s apart, but the recordings started together: still a pair.
    expect(voicePartner([a, b], a)?.id).toBe('b');
    expect(recordingStart(voice('c', P1, START + 1))).toBe(START + 1);
  });
});

describe('flagMarkers', () => {
  it('uses recordingOffsetMs when the flag carries it', () => {
    // The row's createdAtMs lags the recorder start by 300 ms; a derived offset would be 300 ms short.
    const markers = flagMarkers([volume(1, START + 10_000, 10_000)], START + 300, 120_000, liveDispute);
    expect(markers.map(marker => marker.offsetMs)).toEqual([10_000]);
  });

  it('drops flags whose offset points into a different recording of the same match', () => {
    expect(flagMarkers([volume(1, START + 500_000, 5_000)], START, 600_000, liveDispute)).toEqual([]);
  });

  it('falls back to timestamps without recordingOffsetMs', () => {
    expect(flagMarkers([volume(1, START + 4_000), volume(2, START + 4_000, null)], START, 120_000, liveDispute)
      .map(marker => marker.offsetMs)).toEqual([4_000, 4_000]);
  });
});
