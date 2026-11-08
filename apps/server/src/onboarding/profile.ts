import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SetupSelectionDto } from '@tcg-live/core';

export type GuideState = { channelId: string; messageId: string | null; pending: boolean };
export interface SetupProfile { selection: SetupSelectionDto | null; guide: GuideState | null; completed: boolean }

// The source and compiled module are both four directories below the repository root.
export const DEFAULT_SETUP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../data/discord-setup.json');
const EMPTY: SetupProfile = { selection: null, guide: null, completed: false };
const ID = /^[1-9]\d{14,21}$/;

export function validSelection(value: unknown): value is SetupSelectionDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'adminId,channelId,guildId,matchChannels,publicMatchRooms' ||
      ![row.adminId, row.channelId, row.guildId].every(id => typeof id === 'string' && ID.test(id)) ||
      typeof row.publicMatchRooms !== 'boolean') return false;
  if (row.matchChannels === null) return true;
  if (!row.matchChannels || typeof row.matchChannels !== 'object' || Array.isArray(row.matchChannels)) return false;
  const channels = row.matchChannels as Record<string, unknown>;
  return Object.keys(channels).sort().join(',') === 'M1,M2' &&
    [channels.M1, channels.M2].every(id => typeof id === 'string' && ID.test(id)) &&
    channels.M1 !== channels.M2 && row.channelId !== channels.M1 && row.channelId !== channels.M2;
}

export class SetupProfileStore {
  constructor(readonly file = DEFAULT_SETUP_PATH) {}

  async read(): Promise<SetupProfile> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
      throw new Error('Setup profile could not be read.');
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (!value || Object.keys(value).sort().join(',') !== 'completed,guide,selection,version' || value.version !== 1 ||
          typeof value.completed !== 'boolean' ||
          (value.selection !== null && !validSelection(value.selection))) throw new Error();
      const guide = value.guide;
      if (guide !== null && (!guide || typeof guide !== 'object' || Array.isArray(guide) ||
          Object.keys(guide).sort().join(',') !== 'channelId,messageId,pending' ||
          !ID.test((guide as GuideState).channelId) ||
          ((guide as GuideState).messageId !== null && !ID.test((guide as GuideState).messageId!)) ||
          typeof (guide as GuideState).pending !== 'boolean')) throw new Error();
      return { selection: value.selection as SetupSelectionDto | null, guide: guide as GuideState | null,
        completed: value.completed };
    } catch { throw new Error('Setup profile is invalid; review data/discord-setup.json locally.'); }
  }

  async save(profile: SetupProfile): Promise<void> {
    if (profile.selection !== null && !validSelection(profile.selection)) throw new Error('Invalid setup selection.');
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, selection: profile.selection,
        guide: profile.guide, completed: profile.completed }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
