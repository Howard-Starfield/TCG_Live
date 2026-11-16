// Categories for the room pool. Discord holds at most 50 channels in a category, so table k lives in the category for its
// range of 50 (1–50, 51–100, …). Tables 1–50 use the category the organizer chose, if any; every other range (and 1–50
// without a choice) gets a category the bot creates and names "{game} {from}–{to}".
import { MATCH_ROOM_LIMITS, overflowCategoryName } from '@tcg-live/core';
import { RuleError } from '../../rehearsal/domain.js';
import type { MatchRoomDiscord } from './port.js';
import type { MatchRoomCategoryRow, MatchRoomStore } from './store.js';

export interface CategoryDeps {
  guildId: string;
  store: MatchRoomStore;
  discord: MatchRoomDiscord;
  now?: () => number;
  log?: (message: string) => void;
}

export const categoryRange = (index: number) => ({ from: index * MATCH_ROOM_LIMITS.tablesPerCategory + 1,
  to: (index + 1) * MATCH_ROOM_LIMITS.tablesPerCategory });

export class RoomCategories {
  constructor(private readonly deps: CategoryDeps) {}

  /** The existing category for this range of 50 tables, or null when there is none (or it was deleted in Discord). */
  async existing(index: number): Promise<string | null> {
    const { store, discord, guildId } = this.deps;
    const range = categoryRange(index);
    if (index === 0) {
      const chosen = (await store.settings(guildId)).categoryId;
      if (chosen) {
        const channel = await discord.get(chosen);
        if (channel?.kind === 'category' && await this.hasRoom(channel.id)) {
          await this.remember({ guildId, categoryId: channel.id, rangeFrom: range.from, rangeTo: range.to, origin: 'configured',
            createdAtMs: (this.deps.now ?? Date.now)() });
          return channel.id;
        }
        else this.deps.log?.(channel?.kind === 'category' ? 'The chosen room category is full (50 channels); the bot uses its own for the rest of tables 1–50.'
          : 'The chosen room category no longer exists; the bot uses its own for tables 1–50.');
      }
    }
    for (const row of await store.categories(guildId)) {
      if (row.rangeFrom !== range.from || row.origin !== 'created') continue;
      const channel = await discord.get(row.categoryId);
      if (channel?.kind === 'category') return channel.id;
      await store.removeCategory(guildId, row.categoryId);
    }
    return null;
  }

  /** Discord holds at most 50 channels in a category, whoever put them there. */
  private async hasRoom(categoryId: string): Promise<boolean> {
    const inside = (await this.deps.discord.list()).filter(channel => channel.parentId === categoryId).length;
    return inside < MATCH_ROOM_LIMITS.tablesPerCategory;
  }

  /** How many categories creating these tables would add to the server's channel count. */
  async missingCount(tables: readonly number[]): Promise<number> {
    const indexes = [...new Set(tables.map(table => Math.floor((Math.max(1, table) - 1) / MATCH_ROOM_LIMITS.tablesPerCategory)))];
    let missing = 0;
    for (const index of indexes) if (!await this.existing(index)) missing += 1;
    return missing;
  }

  /** The category for the range, creating the bot's own when none exists. */
  async ensure(index: number, gameLabel: string | null): Promise<string> {
    const found = await this.existing(index);
    if (found) return found;
    const { store, discord, guildId } = this.deps;
    if (!discord.canManageChannels()) throw new RuleError('The bot needs Manage Channels to create the room categories.');
    const range = categoryRange(index);
    const settings = await store.settings(guildId);
    // The name the organizer asked for ("create a category") is used once, for tables 1–50.
    const pending = index === 0 ? settings.pendingCategoryName : null;
    const created = await discord.createCategory(pending ?? overflowCategoryName(gameLabel, range.from, range.to), 'TCG Live match rooms');
    const row: MatchRoomCategoryRow = { guildId, categoryId: created.id, rangeFrom: range.from, rangeTo: range.to, origin: 'created',
      createdAtMs: (this.deps.now ?? Date.now)() };
    await store.saveCategory(row);
    if (pending) await store.patchSettings(guildId, { categoryId: created.id, pendingCategoryName: null }, row.createdAtMs);
    return created.id;
  }

  /** Records the organizer's chosen category for tables 1–50 (replacing a previous choice). */
  async configure(categoryId: string | null): Promise<void> {
    const { store, guildId } = this.deps;
    for (const row of await store.categories(guildId)) if (row.origin === 'configured' && row.categoryId !== categoryId)
      await store.removeCategory(guildId, row.categoryId);
    if (categoryId) {
      const range = categoryRange(0);
      await this.remember({ guildId, categoryId, rangeFrom: range.from, rangeTo: range.to, origin: 'configured',
        createdAtMs: (this.deps.now ?? Date.now)() });
    }
  }

  private async remember(row: MatchRoomCategoryRow): Promise<void> {
    const known = (await this.deps.store.categories(this.deps.guildId)).find(item => item.categoryId === row.categoryId);
    if (known && known.origin === row.origin && known.rangeFrom === row.rangeFrom) return;
    // A category the bot created stays "created" even when the organizer later picks it as the chosen one.
    await this.deps.store.saveCategory(known?.origin === 'created' ? known : row);
  }
}
