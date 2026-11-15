// Helper voice-bot tokens, stored only in a local file (data/voice-bots.json, mode 0600, temp+rename).
// Tokens never reach PostgreSQL, logs, error messages or API responses: every public method returns
// summaries, and only getTokens() (for the voice runtime) returns secrets.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODERATION_LIMITS } from '@tcg-live/core';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { readableText, UUID } from '../ops/http.js';

export const DEFAULT_VOICE_BOTS_FILE = fileURLToPath(new URL('../../../../data/voice-bots.json', import.meta.url));

export interface VoiceBotSummary { id: string; label: string; userId: string | null; addedAtMs: number }
/** Internal only: hand to the voice runtime, never serialize. */
export interface VoiceBotCredential extends VoiceBotSummary { token: string }

interface SavedFile { version: 1; bots: VoiceBotCredential[] }

/** The saved file is unreadable; the message never includes file content. */
export class VoiceBotFileError extends OpsConflictError {}

const TOKEN = /^([A-Za-z0-9_-]{16,40})\.([A-Za-z0-9_-]{4,12})\.([A-Za-z0-9_-]{20,100})$/;

/** The token's first segment is the bot user ID in base64; it is public information. */
export function tokenUserId(token: string): string | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64url').toString('utf8');
  return /^[1-9]\d{14,21}$/.test(decoded) ? decoded : null;
}

/** Basic shape check only; Discord itself confirms the token when the voice runtime logs in. */
export function validateBotToken(token: unknown): string {
  if (typeof token !== 'string') throw new OpsInputError('Paste the helper bot token.');
  const value = token.trim().replace(/^Bot\s+/i, '');
  if (value.length > 160 || !TOKEN.test(value) || tokenUserId(value) === null)
    throw new OpsInputError('That does not look like a Discord bot token. Copy it from the Bot page of the helper application.');
  return value;
}

export function validateBotLabel(label: unknown): string {
  if (typeof label !== 'string' || !label.trim() || !readableText(label.trim(), MODERATION_LIMITS.voiceBotLabelLength))
    throw new OpsInputError(`Name the helper bot with 1-${MODERATION_LIMITS.voiceBotLabelLength} readable characters.`);
  return label.trim();
}

function parseFile(text: string): SavedFile {
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.bots)) throw new Error('invalid');
  const bots = value.bots.map(item => {
    const bot = item as Record<string, unknown>;
    if (!bot || typeof bot !== 'object' || typeof bot.id !== 'string' || !UUID.test(bot.id) ||
        typeof bot.label !== 'string' || typeof bot.token !== 'string' || !TOKEN.test(bot.token) ||
        !Number.isSafeInteger(bot.addedAtMs)) throw new Error('invalid');
    return { id: bot.id, label: bot.label, token: bot.token, userId: tokenUserId(bot.token), addedAtMs: bot.addedAtMs as number };
  });
  return { version: 1, bots };
}

const summary = ({ id, label, userId, addedAtMs }: VoiceBotCredential): VoiceBotSummary => ({ id, label, userId, addedAtMs });

export class VoiceBotTokenStore {
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string = DEFAULT_VOICE_BOTS_FILE, private readonly now: () => number = Date.now) {}

  private async load(): Promise<SavedFile> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bots: [] };
      throw new VoiceBotFileError('The helper bot list could not be read.');
    }
    try { return parseFile(text); }
    catch { throw new VoiceBotFileError('The saved helper bot list is invalid. Remove data/voice-bots.json and add the helper bots again.'); }
  }

  private async save(next: SavedFile): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.voice-bots-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } catch {
      throw new VoiceBotFileError('The helper bot list could not be saved.');
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private transact<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(run, run);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<VoiceBotSummary[]> {
    return (await this.load()).bots.map(summary);
  }

  async add(label: unknown, token: unknown): Promise<VoiceBotSummary> {
    const name = validateBotLabel(label);
    const secret = validateBotToken(token);
    return this.transact(async () => {
      const saved = await this.load();
      if (saved.bots.length >= MODERATION_LIMITS.voiceHelperBots)
        throw new OpsConflictError(`At most ${MODERATION_LIMITS.voiceHelperBots} helper bots can be added.`);
      const userId = tokenUserId(secret);
      if (saved.bots.some(bot => bot.token === secret || (userId !== null && bot.userId === userId)))
        throw new OpsConflictError('That helper bot is already in the list.');
      const bot: VoiceBotCredential = { id: randomUUID(), label: name, token: secret, userId, addedAtMs: this.now() };
      await this.save({ version: 1, bots: [...saved.bots, bot] });
      return summary(bot);
    });
  }

  async remove(id: string): Promise<VoiceBotSummary> {
    return this.transact(async () => {
      const saved = await this.load();
      const bot = UUID.test(id) ? saved.bots.find(item => item.id === id.toLowerCase()) : undefined;
      if (!bot) throw new OpsNotFoundError('Helper bot not found.');
      await this.save({ version: 1, bots: saved.bots.filter(item => item !== bot) });
      return summary(bot);
    });
  }

  /** Voice runtime only. The result holds secrets: never log, serialize or return it over HTTP. */
  async getTokens(): Promise<VoiceBotCredential[]> {
    return (await this.load()).bots.map(bot => ({ ...bot }));
  }
}

/** What the routes and the voice runtime need; VoiceBotTokenStore is the file-backed production one. */
export type VoiceBotRegistry = Pick<VoiceBotTokenStore, 'list' | 'add' | 'remove' | 'getTokens'>;

/** In-memory registry for tests and the demo: nothing is written to disk. */
export class MemoryVoiceBotRegistry implements VoiceBotRegistry {
  private bots: VoiceBotCredential[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async list() { return this.bots.map(summary); }
  async add(label: unknown, token: unknown) {
    const name = validateBotLabel(label);
    const secret = validateBotToken(token);
    if (this.bots.length >= MODERATION_LIMITS.voiceHelperBots)
      throw new OpsConflictError(`At most ${MODERATION_LIMITS.voiceHelperBots} helper bots can be added.`);
    const userId = tokenUserId(secret);
    if (this.bots.some(bot => bot.token === secret || (userId !== null && bot.userId === userId)))
      throw new OpsConflictError('That helper bot is already in the list.');
    const bot: VoiceBotCredential = { id: randomUUID(), label: name, token: secret, userId, addedAtMs: this.now() };
    this.bots.push(bot);
    return summary(bot);
  }
  async remove(id: string) {
    const bot = UUID.test(id) ? this.bots.find(item => item.id === id.toLowerCase()) : undefined;
    if (!bot) throw new OpsNotFoundError('Helper bot not found.');
    this.bots = this.bots.filter(item => item !== bot);
    return summary(bot);
  }
  async getTokens() { return this.bots.map(bot => ({ ...bot })); }
}
