// Rooms vs bots, and the disk an hour of recording takes, measured against the evidence quota.
import { EVIDENCE_QUOTA_BYTES, type VoiceBotPoolDto } from '@tcg-live/core';
import { formatBytes } from '../../evidence/api';
import { BYTES_PER_ROOM_HOUR } from './api';

/** Rooms left without a bot: the live count when the runtime runs, otherwise rooms minus enabled bots. */
export function capacity(pool: VoiceBotPoolDto, knownRooms: number) {
  const bots = pool.bots.filter(bot => bot.enabled !== false).length;
  const rooms = Math.max(knownRooms, pool.rooms.length);
  const shortfall = pool.runtime === 'running' ? pool.rooms.filter(room => room.botId === null).length : Math.max(0, rooms - bots);
  return { bots, rooms, shortfall };
}

export function CapacityBanner({ pool, knownRooms }: { pool: VoiceBotPoolDto; knownRooms: number }) {
  const { bots, rooms, shortfall } = capacity(pool, knownRooms);
  const hourly = rooms * BYTES_PER_ROOM_HOUR;
  return <div role="status" aria-label="Capacity" className={`flex flex-col gap-0.5 rounded-md p-2 text-xs ${shortfall
    ? 'border border-warning bg-warning-soft text-fg' : 'bg-sunken text-fg-muted'}`}>
    <span><b>{rooms} room{rooms === 1 ? '' : 's'} · {bots} bot{bots === 1 ? '' : 's'}</b>
      {shortfall ? ` → ${shortfall} room${shortfall === 1 ? '' : 's'} unmonitored ${pool.runtime === 'running' ? 'now' : 'when all need coverage'}.` : ' → every room can be covered.'}</span>
    {rooms > 0 && <span>Recording every room uses about {formatBytes(hourly)} per hour (quota {formatBytes(EVIDENCE_QUOTA_BYTES)},
      about {Math.max(0, Math.floor(EVIDENCE_QUOTA_BYTES / hourly))} h). Recording alone barely uses the CPU; loudness checks stay under 5% of a core per room.</span>}
  </div>;
}
