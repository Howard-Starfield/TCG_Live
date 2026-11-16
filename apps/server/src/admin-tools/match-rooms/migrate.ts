// First start with match rooms: existing rooms join the pool, and the server's current layout is saved as the baseline.
import type { MatchId } from '@tcg-live/core';
import type { RoomOverwrite } from '../../discord/match-rooms.js';
import type { MatchRoomDiscord, RoomChannel } from './port.js';
import type { MatchRoomStore } from './store.js';

export interface MigrateDeps {
  guildId: string;
  applicationId: string;
  store: MatchRoomStore;
  discord: MatchRoomDiscord;
  /** The frozen legacy rooms (`config.matchChannels`: M1 and M2). */
  legacyChannels?: Partial<Record<MatchId, string>>;
  /** The active session's identity_map.roundRooms. */
  activeRoundRooms?: Partial<Record<MatchId, string>>;
  backup: (guildId: string, channelId: string, overwrites: readonly RoomOverwrite[]) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

/** The name the bot gave rooms it created before the pool: "TCG Match M3 · application ID". Group 1 is the match. */
export const legacyCreatedName = (applicationId: string) => new RegExp(`^TCG Match (M[1-9][0-9]*) · ${applicationId}$`);
const tableOfMatch = (id: string): number => Number(id.slice(1));

/**
 * Brings the rooms of the old way of working into the pool. Idempotent, and it only runs while the pool is empty:
 *  - the configured M1 and M2 rooms become tables 1 and 2, adopted, with their original name and overwrites saved. They get no
 *    custom name, so the next event renames them to the template;
 *  - the active session's rooms are adopted by ID;
 *  - voice channels the bot created for earlier rounds (named exactly "TCG Match Mk · application ID") become created rooms.
 */
export async function migrateLegacyRooms(deps: MigrateDeps): Promise<{ adopted: number; created: number }> {
  const { store, discord, guildId } = deps;
  if ((await store.rooms(guildId)).length) return { adopted: 0, created: 0 };
  const candidates: Array<{ channelId: string; table: number }> = [];
  for (const [id, channelId] of Object.entries(deps.legacyChannels ?? {})) if (channelId) candidates.push({ channelId, table: tableOfMatch(id) });
  for (const [id, channelId] of Object.entries(deps.activeRoundRooms ?? {})) if (channelId) candidates.push({ channelId, table: tableOfMatch(id) });
  let listed: RoomChannel[] = [];
  try { listed = await discord.list(); } catch { deps.log?.('Room migration could not list the server channels.'); }
  const pattern = legacyCreatedName(deps.applicationId);
  for (const channel of listed) {
    const found = channel.kind === 'voice' ? channel.name.match(pattern) : null;
    if (found) candidates.push({ channelId: channel.id, table: tableOfMatch(found[1]!) });
  }
  const result = { adopted: 0, created: 0 };
  const usedTables = new Set<number>();
  const usedChannels = new Set<string>();
  for (const candidate of candidates) {
    if (usedTables.has(candidate.table) || usedChannels.has(candidate.channelId) || candidate.table < 1) continue;
    let channel: RoomChannel | null;
    try { channel = listed.find(item => item.id === candidate.channelId) ?? await discord.get(candidate.channelId); }
    catch { deps.log?.(`Room migration skipped ${candidate.channelId}: it could not be read.`); continue; }
    if (channel?.kind !== 'voice' || channel.id === discord.afkChannelId()) continue;
    const created = pattern.test(channel.name);
    if (!created) {
      try { await deps.backup(guildId, channel.id, await discord.overwrites(channel.id)); }
      catch { deps.log?.(`Room migration skipped ${channel.name}: its overwrites could not be saved first.`); continue; }
    }
    await store.insertRoom({ guildId, channelId: channel.id, applicationId: deps.applicationId, tableNo: candidate.table,
      categoryId: channel.parentId, origin: created ? 'created' : 'adopted', customName: null, appliedName: channel.name, desiredName: null,
      originalName: created ? null : channel.name, renameLog: [], nextRenameAtMs: null, renameError: null, missingSinceMs: null,
      createdAtMs: (deps.now ?? Date.now)() });
    usedTables.add(candidate.table);
    usedChannels.add(channel.id);
    result[created ? 'created' : 'adopted'] += 1;
  }
  return result;
}

/**
 * The first time, saves every voice channel, stage channel and category that is not part of the pool as the server baseline:
 * the layout clean-up restores. The organizer can edit the list in Settings. Returns true when it captured.
 */
export async function captureBaseline(deps: Pick<MigrateDeps, 'guildId' | 'store' | 'discord' | 'now'>): Promise<boolean> {
  const { store, discord, guildId } = deps;
  const settings = await store.settings(guildId);
  if (settings.baselineCapturedAtMs !== null) return false;
  const pool = new Set<string>((await store.rooms(guildId)).map(room => room.channelId));
  for (const category of await store.categories(guildId)) pool.add(category.categoryId);
  if (settings.categoryId) pool.add(settings.categoryId);
  const now = (deps.now ?? Date.now)();
  const ids = (await discord.list()).filter(channel => channel.kind === 'voice' || channel.kind === 'stage' || channel.kind === 'category')
    .map(channel => channel.id).filter(id => !pool.has(id));
  await store.patchSettings(guildId, { baselineChannelIds: ids, baselineCapturedAtMs: now }, now);
  return true;
}
