import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SetupSelectionDto } from '@tcg-live/core';

export type GuideState = { channelId: string; messageId: string | null; pending: boolean };
/** Local switches for the guided start. Saved beside the setup selection; never secrets. */
export interface LocalSwitches { dashboardActions: boolean; voiceMonitoring: boolean }
export interface SetupProfile {
  selection: SetupSelectionDto | null; guide: GuideState | null; completed: boolean;
  /** Omitted on save: the switches already on disk are kept (setup saves never reset them). */
  settings?: LocalSwitches;
}
/** Migration: a missing field means "Allow dashboard actions" on and voice monitoring off. */
export const DEFAULT_SWITCHES: Readonly<LocalSwitches> = Object.freeze({ dashboardActions: true, voiceMonitoring: false });

// The source and compiled module are both four directories below the repository root.
export const DEFAULT_SETUP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../data/discord-setup.json');
const EMPTY: SetupProfile = { selection: null, guide: null, completed: false };
const PROFILE_KEYS = new Set(['completed', 'guide', 'selection', 'version', 'settings']);
/** Saves to one file never interleave inside this process (setup and settings both read, then write). */
const queues = new Map<string, Promise<unknown>>();

function switches(value: unknown): LocalSwitches {
  if (value === undefined) return { ...DEFAULT_SWITCHES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'dashboardActions' && key !== 'voiceMonitoring')) throw new Error();
  const pick = (key: keyof LocalSwitches) => {
    if (row[key] === undefined) return DEFAULT_SWITCHES[key];
    if (typeof row[key] !== 'boolean') throw new Error();
    return row[key] as boolean;
  };
  return { dashboardActions: pick('dashboardActions'), voiceMonitoring: pick('voiceMonitoring') };
}
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
      const keys = value && typeof value === 'object' ? Object.keys(value) : [];
      if (!value || keys.some(key => !PROFILE_KEYS.has(key)) ||
          !['completed', 'guide', 'selection', 'version'].every(key => keys.includes(key)) || value.version !== 1 ||
          typeof value.completed !== 'boolean' ||
          (value.selection !== null && !validSelection(value.selection))) throw new Error();
      const guide = value.guide;
      if (guide !== null && (!guide || typeof guide !== 'object' || Array.isArray(guide) ||
          Object.keys(guide).sort().join(',') !== 'channelId,messageId,pending' ||
          !ID.test((guide as GuideState).channelId) ||
          ((guide as GuideState).messageId !== null && !ID.test((guide as GuideState).messageId!)) ||
          typeof (guide as GuideState).pending !== 'boolean')) throw new Error();
      return { selection: value.selection as SetupSelectionDto | null, guide: guide as GuideState | null,
        completed: value.completed, settings: switches(value.settings) };
    } catch { throw new Error('Setup profile is invalid; review data/discord-setup.json locally.'); }
  }

  async save(profile: SetupProfile): Promise<void> {
    if (profile.selection !== null && !validSelection(profile.selection)) throw new Error('Invalid setup selection.');
    if (profile.settings !== undefined) switches(profile.settings);
    await this.serialized(async () => {
      const settings = profile.settings ?? (await this.read().catch(() => EMPTY)).settings ?? { ...DEFAULT_SWITCHES };
      await this.write({ ...profile, settings });
    });
  }

  /** Reads, changes and saves only the switches, keeping the setup selection and guide as they are. */
  async updateSwitches(change: (current: LocalSwitches) => LocalSwitches): Promise<LocalSwitches> {
    return this.serialized(async () => {
      const current = await this.read();
      const next = switches(change(current.settings ?? { ...DEFAULT_SWITCHES }));
      await this.write({ ...current, settings: next });
      return next;
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.file) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    queues.set(this.file, tail);
    void tail.then(() => { if (queues.get(this.file) === tail) queues.delete(this.file); });
    return run;
  }

  private async write(profile: SetupProfile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, selection: profile.selection,
        guide: profile.guide, completed: profile.completed, settings: profile.settings ?? { ...DEFAULT_SWITCHES } }),
      { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
