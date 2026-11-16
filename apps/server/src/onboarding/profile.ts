import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SetupSelectionDto, TournamentRoleIdsDto } from '@tcg-live/core';

export type GuideState = { channelId: string; messageId: string | null; pending: boolean };
/** Local switches for the guided start. Saved beside the setup selection; never secrets. */
export interface LocalSwitches { dashboardActions: boolean; voiceMonitoring: boolean }
export interface SetupProfile {
  selection: SetupSelectionDto | null; guide: GuideState | null; completed: boolean;
  /** Omitted on save: the switches already on disk are kept (setup saves never reset them). */
  settings?: LocalSwitches;
  /** The bot-managed TCG Organizer and TCG Judge role IDs. Omitted on save: the saved IDs are kept; null clears them. */
  roles?: TournamentRoleIdsDto | null;
}
/** Migration: a missing field means "Allow dashboard actions" on and voice monitoring off. */
export const DEFAULT_SWITCHES: Readonly<LocalSwitches> = Object.freeze({ dashboardActions: true, voiceMonitoring: false });

// The source and compiled module are both four directories below the repository root.
export const DEFAULT_SETUP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../data/discord-setup.json');
const EMPTY: SetupProfile = { selection: null, guide: null, completed: false };
const PROFILE_KEYS = new Set(['completed', 'guide', 'selection', 'version', 'settings', 'roles']);
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

function roleIds(value: unknown): TournamentRoleIdsDto | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'guildId,judgeRoleId,organizerRoleId' ||
      typeof row.guildId !== 'string' || !ID.test(row.guildId) ||
      ![row.organizerRoleId, row.judgeRoleId].every(id => id === null || (typeof id === 'string' && ID.test(id)))) throw new Error();
  return { guildId: row.guildId, organizerRoleId: row.organizerRoleId as string | null, judgeRoleId: row.judgeRoleId as string | null };
}

/** The optional match room pool choice: a category to use, or a request to create one (never both). */
function validMatchRooms(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'categoryId,createCategory' || typeof row.createCategory !== 'boolean') return false;
  if (row.categoryId !== null && !(typeof row.categoryId === 'string' && ID.test(row.categoryId))) return false;
  return !(row.categoryId !== null && row.createCategory);
}

export function validSelection(value: unknown): value is SetupSelectionDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  // matchRooms is the only optional key: legacy selections never had it.
  const { matchRooms, ...required } = row;
  if (Object.keys(required).sort().join(',') !== 'adminId,channelId,guildId,matchChannels,publicMatchRooms' ||
      ![row.adminId, row.channelId, row.guildId].every(id => typeof id === 'string' && ID.test(id)) ||
      typeof row.publicMatchRooms !== 'boolean' || ('matchRooms' in row && !validMatchRooms(matchRooms))) return false;
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
      const roles = roleIds(value.roles);
      return { selection: value.selection as SetupSelectionDto | null, guide: guide as GuideState | null,
        completed: value.completed, settings: switches(value.settings), ...(roles ? { roles } : {}) };
    } catch { throw new Error('Setup profile is invalid; review data/discord-setup.json locally.'); }
  }

  async save(profile: SetupProfile): Promise<void> {
    if (profile.selection !== null && !validSelection(profile.selection)) throw new Error('Invalid setup selection.');
    if (profile.settings !== undefined) switches(profile.settings);
    if (profile.roles) roleIds(profile.roles);
    await this.serialized(async () => {
      // An unreadable file must not turn into "no roles": keeping the saved IDs means reading them, so fail the save instead.
      const disk = profile.roles === undefined ? await this.read() :
        profile.settings === undefined ? await this.read().catch(() => EMPTY) : EMPTY;
      const settings = profile.settings ?? disk.settings ?? { ...DEFAULT_SWITCHES };
      const roles = profile.roles === undefined ? disk.roles ?? null : profile.roles;
      await this.write({ ...profile, settings, roles });
    });
  }

  /** Reads, changes and saves only the role IDs, keeping the setup selection, guide and switches as they are. */
  async updateRoles(change: (current: TournamentRoleIdsDto | null) => TournamentRoleIdsDto | null): Promise<void> {
    await this.serialized(async () => {
      const current = await this.read();
      const next = change(current.roles ?? null);
      if (next) roleIds(next);
      await this.write({ ...current, roles: next });
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
        guide: profile.guide, completed: profile.completed, settings: profile.settings ?? { ...DEFAULT_SWITCHES },
        ...(profile.roles ? { roles: profile.roles } : {}) }),
      { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
