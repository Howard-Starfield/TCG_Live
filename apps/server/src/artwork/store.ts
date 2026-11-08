import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';
import { ARTWORK_GAMES, ARTWORK_SLOTS, type ArtworkGame, type ArtworkProfileDto,
  type ArtworkSelectionDto, type ArtworkSlot } from '@tcg-live/core';

export const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;
export const MAX_ARTWORK_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_000_000;
const FILENAME = /^(one-piece|one-punch-man|pokemon)-(banner|thumbnail)-([a-f0-9]{64})\.(gif|png|jpg)$/;
type ImageType = 'gif' | 'png' | 'jpg';
type Ref = { filename: string; type: ImageType; width: number; height: number };
type Profile = { version: 1; activeGame: ArtworkGame | null;
  games: Record<ArtworkGame, Partial<Record<ArtworkSlot, Ref>>> };
export type ResolvedArtwork = { filename: string; path: string; contentType: 'image/gif' | 'image/png' | 'image/jpeg';
  width: number; height: number; source: 'default' | 'custom'; revision: string };

const contentTypes = { gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg' } as const;
const gameSet = new Set<string>(ARTWORK_GAMES);
const slotSet = new Set<string>(ARTWORK_SLOTS);
const defaultsRoot = fileURLToPath(new URL('../../assets/games/', import.meta.url));
export const DEFAULT_ARTWORK_DIR = fileURLToPath(new URL('../../../../data/artwork/', import.meta.url));

export function artworkGame(value: string): ArtworkGame {
  if (!gameSet.has(value)) throw new ArtworkInputError('Choose a supported game.');
  return value as ArtworkGame;
}
export function artworkSlot(value: string): ArtworkSlot {
  if (!slotSet.has(value)) throw new ArtworkInputError('Choose banner or thumbnail artwork.');
  return value as ArtworkSlot;
}
export class ArtworkInputError extends Error {}

function emptyProfile(): Profile {
  return { version: 1, activeGame: null, games: {
    'one-piece': {}, 'one-punch-man': {}, pokemon: {}
  } };
}

function parseProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid artwork profile.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'activeGame,games,version' ||
      value.version !== 1 || (value.activeGame !== null && (typeof value.activeGame !== 'string' || !gameSet.has(value.activeGame))) ||
      !value.games || typeof value.games !== 'object' || Array.isArray(value.games)) throw new Error('Invalid artwork profile.');
  if (Object.keys(value.games).sort().join(',') !== [...ARTWORK_GAMES].sort().join(',')) throw new Error('Invalid artwork profile.');
  const profile = emptyProfile();
  profile.activeGame = value.activeGame as ArtworkGame | null;
  for (const game of ARTWORK_GAMES) {
    const record = (value.games as Record<string, unknown>)[game];
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid artwork profile.');
    if (Object.keys(record).some(key => !slotSet.has(key))) throw new Error('Invalid artwork profile.');
    for (const slot of ARTWORK_SLOTS) {
      const ref = (record as Record<string, unknown>)[slot];
      if (ref === undefined) continue;
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('Invalid artwork profile.');
      const image = ref as Record<string, unknown>;
      const match = typeof image.filename === 'string' ? FILENAME.exec(image.filename) : null;
      if (Object.keys(image).sort().join(',') !== 'filename,height,type,width' ||
          !match || match[1] !== game || match[2] !== slot || image.type !== match[4] ||
          !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
          (image.width as number) < 1 || (image.height as number) < 1 ||
          (image.width as number) > MAX_DIMENSION || (image.height as number) > MAX_DIMENSION ||
          (image.width as number) * (image.height as number) > MAX_PIXELS) throw new Error('Invalid artwork profile.');
      profile.games[game][slot] = image as Ref;
    }
  }
  return profile;
}

function inspect(bytes: Buffer): { type: ImageType; width: number; height: number } {
  if (bytes.length < 16 || bytes.length > MAX_ARTWORK_BYTES) throw new ArtworkInputError('Artwork must be at most 4 MB.');
  let type: ImageType;
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
    if (bytes.at(-1) !== 0x3b) throw new ArtworkInputError('GIF artwork is incomplete.');
    type = 'gif';
  } else if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    if (bytes.subarray(-12, -8).toString('hex') !== '00000000' || bytes.subarray(-8, -4).toString('ascii') !== 'IEND')
      throw new ArtworkInputError('PNG artwork is incomplete.');
    type = 'png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new ArtworkInputError('JPEG artwork is incomplete.');
    type = 'jpg';
  } else throw new ArtworkInputError('Use a GIF, PNG or JPEG image.');
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); } catch { throw new ArtworkInputError('Image dimensions could not be read.'); }
  if (dimensions.type !== (type === 'jpg' ? 'jpg' : type) || !dimensions.width || !dimensions.height ||
      dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_DIMENSION ||
      dimensions.height > MAX_DIMENSION || dimensions.width * dimensions.height > MAX_PIXELS)
    throw new ArtworkInputError('Image dimensions must be 1–4096 pixels per side and at most 16 MP.');
  return { type, width: dimensions.width, height: dimensions.height };
}

/** One instance is shared by the HTTP routes and Discord visual resolver. */
export class ArtworkStore {
  private profile = emptyProfile();
  private loadIssue: string | null = null;
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly known = new Map<string, ResolvedArtwork>();
  private constructor(readonly directory: string) {}

  static async open(directory = DEFAULT_ARTWORK_DIR): Promise<ArtworkStore> {
    const store = new ArtworkStore(path.resolve(directory));
    try { store.profile = parseProfile(JSON.parse(await readFile(path.join(store.directory, 'profile.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') store.loadIssue = 'Saved artwork settings are invalid; using default artwork until you save a selection.'; }
    store.rememberSelected();
    return store;
  }

  static openSync(directory = DEFAULT_ARTWORK_DIR): ArtworkStore {
    const store = new ArtworkStore(path.resolve(directory));
    try { store.profile = parseProfile(JSON.parse(readFileSync(path.join(store.directory, 'profile.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') store.loadIssue = 'Saved artwork settings are invalid; using default artwork until you save a selection.'; }
    store.rememberSelected();
    return store;
  }

  private transact<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(run, run);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async save(next: Profile): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.profile-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path.join(this.directory, 'profile.json'));
    } finally { await unlink(temporary).catch(() => {}); }
    this.profile = next;
    this.loadIssue = null;
    this.rememberSelected();
  }

  private async usedUploadBytes(): Promise<number> {
    let used = 0;
    for (const game of ARTWORK_GAMES) {
      const folder = path.join(this.directory, 'uploads', game);
      let names: string[];
      try { names = await readdir(folder); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const name of names) {
        if (!FILENAME.test(name)) continue;
        used += (await stat(path.join(folder, name))).size;
      }
    }
    return used;
  }

  private rememberSelected(): void {
    for (const game of ARTWORK_GAMES) for (const slot of ARTWORK_SLOTS) {
      const image = this.resolve(game, slot);
      if (image) this.known.set(image.filename, image);
    }
  }

  async selectGame(game: ArtworkGame | null): Promise<ArtworkProfileDto> {
    if (game !== null) artworkGame(game);
    return this.transact(async () => {
      await this.save({ ...this.profile, activeGame: game });
      return this.describe();
    });
  }

  async upload(game: ArtworkGame, slot: ArtworkSlot, bytes: Buffer, declaredType?: string): Promise<ArtworkProfileDto> {
    artworkGame(game); artworkSlot(slot);
    const dimensions = inspect(bytes);
    if (declaredType && declaredType !== contentTypes[dimensions.type])
      throw new ArtworkInputError('Image type does not match its content.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const filename = `${game}-${slot}-${hash}.${dimensions.type}`;
    return this.transact(async () => {
      const folder = path.join(this.directory, 'uploads', game);
      await mkdir(folder, { recursive: true });
      const destination = path.join(folder, filename);
      try { await stat(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (await this.usedUploadBytes() + bytes.length > MAX_ARTWORK_TOTAL_BYTES)
          throw new ArtworkInputError('Artwork uploads have reached the 64 MB storage limit. Archive old uploads before adding another.');
        const temporary = path.join(folder, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          await rename(temporary, destination);
        } finally { await unlink(temporary).catch(() => {}); }
      }
      const next: Profile = { ...this.profile, games: { ...this.profile.games,
        [game]: { ...this.profile.games[game], [slot]: { filename, ...dimensions } } } };
      await this.save(next);
      return this.describe();
    });
  }

  async reset(game: ArtworkGame, slot: ArtworkSlot): Promise<ArtworkProfileDto> {
    artworkGame(game); artworkSlot(slot);
    return this.transact(async () => {
      const slots = { ...this.profile.games[game] };
      delete slots[slot];
      await this.save({ ...this.profile, games: { ...this.profile.games, [game]: slots } });
      return this.describe();
    });
  }

  /** Returns only a server-derived path; never accepts a client filename or path. */
  resolve(game: ArtworkGame, slot: ArtworkSlot): ResolvedArtwork | null {
    artworkGame(game); artworkSlot(slot);
    const ref = this.profile.games[game][slot];
    if (ref) {
      const selectedPath = path.join(this.directory, 'uploads', game, ref.filename);
      if (existsSync(selectedPath)) return { filename: ref.filename, path: selectedPath,
        contentType: contentTypes[ref.type], width: ref.width, height: ref.height, source: 'custom',
        revision: ref.filename.match(FILENAME)![3]! };
    }
    if (slot === 'thumbnail') return null;
    const packagedPath = path.join(defaultsRoot, game, 'gifs', 'tournament.gif');
    if (!existsSync(packagedPath)) return null;
    return { filename: `${game}-tournament.gif`, path: packagedPath,
      contentType: 'image/gif', width: 0, height: 0, source: 'default', revision: 'packaged' };
  }

  resolveActive(slot: ArtworkSlot): ResolvedArtwork | null {
    return this.profile.activeGame ? this.resolve(this.profile.activeGame, slot) : null;
  }

  /** Current-profile lookup for attachment:// references. */
  visualFile(filename: string): ResolvedArtwork | null {
    const image = this.known.get(filename);
    return image && existsSync(image.path) ? image : null;
  }

  async preview(game: ArtworkGame, slot: ArtworkSlot): Promise<{ bytes: Buffer; image: ResolvedArtwork } | null> {
    const image = this.resolve(game, slot);
    if (!image) return null;
    try { return { image, bytes: await readFile(image.path) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  describe(): ArtworkProfileDto {
    const games = {} as ArtworkProfileDto['games'];
    for (const game of ARTWORK_GAMES) {
      games[game] = {} as Record<ArtworkSlot, ArtworkSelectionDto>;
      for (const slot of ARTWORK_SLOTS) {
        const image = this.resolve(game, slot);
        games[game][slot] = image ? { source: image.source, contentType: image.contentType,
          width: image.width || null, height: image.height || null, revision: image.revision } :
          { source: 'none', contentType: null, width: null, height: null, revision: null };
      }
    }
    return { activeGame: this.profile.activeGame, games,
      ...(this.loadIssue ? { loadIssue: this.loadIssue } : {}) };
  }
}

let defaultStore: ArtworkStore | null = null;
export function defaultArtworkStore(): ArtworkStore { return defaultStore ??= ArtworkStore.openSync(); }
