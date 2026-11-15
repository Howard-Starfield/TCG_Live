// Evidence drawer, moderation settings and the Flags tab against an in-memory fake API (light and dark).
// Media playback cannot load here (the fake issues tickets for files that do not exist).
import { CAPABILITIES, DEFAULT_MODERATION_SETTINGS, type EvidenceItemDto, type ModerationFlagDto,
  type ModerationSettingsDto, type SessionDto, type VoiceBotPoolDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { useState } from 'react';
import { AdminDataProvider, createAdminData, createMemoryStorage, ServerClock, SESSION_TOKEN_KEY, type FetchLike } from '../data';
import { EvidenceButton } from '../features/evidence';
import { FlagsTab, ModerationSettings } from '../features/moderation';
import { Button } from '../ui';
import { GalleryFrame } from './GalleryFrame';

const session: SessionDto = { principal: { kind: 'local', id: 'local-admin', label: 'Local admin' }, capabilities: [...CAPABILITIES],
  expiresAtMs: null, idleExpiresAtMs: null, mode: 'demo', commandsEnabled: false, evidence: true, moderation: true };
const evidence = (id: string, overrides: Partial<EvidenceItemDto>): EvidenceItemDto => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, eventId: liveDispute.eventId, matchId: 'M2', proposalRevision: 1, kind: 'upload',
  source: 'discord', submittedBy: 'local-admin', seat: null, note: '', originalName: null, mime: 'video/mp4', byteSize: 48_000_000,
  sha256: null, durationMs: 95_000, externalUrl: null, playable: true, status: 'stored', hold: false,
  createdAtMs: FIXTURE_NOW_MS - 300_000, deletedAtMs: null, deleteReason: null, ...overrides });
const items = [
  evidence('01', { seat: 'D', note: 'Opponent drew an extra card here', originalName: 'turn4.mp4' }),
  evidence('02', { kind: 'link', seat: 'C', mime: null, byteSize: null, durationMs: null, externalUrl: 'https://streamable.com/xyz', hold: true }),
  evidence('03', { kind: 'voice', source: 'bot', submittedBy: 'bot', seat: 'C', mime: 'audio/ogg', byteSize: 900_000, createdAtMs: FIXTURE_NOW_MS - 200_000 }),
  evidence('04', { kind: 'voice', source: 'bot', submittedBy: 'bot', seat: 'D', mime: 'audio/ogg', byteSize: 880_000, createdAtMs: FIXTURE_NOW_MS - 199_000 }),
  evidence('05', { mime: 'video/x-matroska', playable: false, originalName: 'full-game.mkv', createdAtMs: FIXTURE_NOW_MS - 100_000 })
];
const flags: ModerationFlagDto[] = [
  { id: 1, guildId: '100000000000000001', channelId: null, eventId: liveDispute.eventId, matchId: 'M2', userId: null,
    occurredAtMs: FIXTURE_NOW_MS - 170_000, kind: 'volume', detail: { peakDbfs: -1.5, rmsDbfs: -5, sustainedMs: 700, thresholdDbfs: -8 } },
  { id: 2, guildId: '100000000000000001', channelId: null, eventId: liveDispute.eventId, matchId: 'M1', userId: null,
    occurredAtMs: FIXTURE_NOW_MS - 60_000, kind: 'keyword', detail: { ruleId: null, ruleName: 'TCG Live – custom words', action: 'block', matchedKeyword: 'n**b', matchedContent: null } }
];
const settings: ModerationSettingsDto = { ...structuredClone(DEFAULT_MODERATION_SETTINGS), guildId: '100000000000000001', version: 2, updatedAtMs: FIXTURE_NOW_MS };
const pool: VoiceBotPoolDto = { runtime: 'running', rooms: [{ matchId: 'M1', channelId: '200000000000000001', botId: 'main' },
  { matchId: 'M2', channelId: '200000000000000002', botId: null }],
bots: [{ id: 'main', label: 'TCG Live', kind: 'main', userId: null, connected: true, assignedChannelId: '200000000000000001', assignedMatchId: 'M1', addedAtMs: null }] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetch: FetchLike = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  const path = new URL(input, 'http://gallery.local').pathname.replace(/^\/api\/v1/, '');
  if (path === '/session') return json(200, session);
  if (path.endsWith('/evidence') && method === 'GET') return json(200, { eventId: liveDispute.eventId, matchId: 'M2', items });
  if (path.endsWith('/playback')) return json(200, { url: '/api/v1/media/gallery', expiresAtMs: FIXTURE_NOW_MS + 900_000 });
  if (path === '/moderation/settings') return json(200, settings);
  if (path === '/moderation/voice-bots') return json(200, pool);
  if (path === '/moderation/flags') return json(200, { flags, nextAfter: 2 });
  if (path === '/stream' || path === '/status' || path === '/events') return new Promise<Response>(() => {});
  return json(501, { error: { code: 'unavailable', message: 'Not in the gallery.' } });
};

function Specimen() {
  const [data] = useState(() => {
    const storage = createMemoryStorage();
    storage.setItem(SESSION_TOKEN_KEY, 'gallery');
    return createAdminData({ fetch, sessionStorage: storage, location: null, history: null, clock: new ServerClock(() => FIXTURE_NOW_MS),
      expectedBuildId: null, reload: () => {}, stream: { eventTarget: null, isOnline: () => true } });
  });
  const [open, setOpen] = useState(false);
  return <AdminDataProvider data={data}>
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <EvidenceButton snapshot={liveDispute} matchId="M2" />
        <Button size="sm" onClick={() => setOpen(true)}>Moderation & evidence…</Button>
      </div>
      <div className="flex h-72 flex-col rounded-lg bg-raised p-2"><FlagsTab snapshot={liveDispute} /></div>
      <ModerationSettings open={open} onClose={() => setOpen(false)} />
    </div>
  </AdminDataProvider>;
}

export function ModerationGallery() {
  return <GalleryFrame title="Evidence & moderation">{() => <Specimen />}</GalleryFrame>;
}
