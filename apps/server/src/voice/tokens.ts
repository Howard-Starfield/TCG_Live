// Helper voice-bot tokens, stored only in a local file (data/voice-bots.json, mode 0600, temp+rename).
// Tokens never reach PostgreSQL, logs, error messages or API responses: every public method returns
// summaries or token-free reports, and only getTokens() (for the voice runtime) returns secrets. Calls to
// Discord with a helper's token (probe, verify, nickname) happen inside this module through helper-api.ts.
// On Windows the 0600 mode is effectively ignored: the file is protected by the user-profile folder, the
// same protection as the main token in .env.
//
// File versions: 1 = {id,label,token,addedAtMs}; 2 adds applicationId, enabled and nickname. A v1 file is
// read as v2 (enabled, no application ID or nickname) and written as v2 on the next save.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODERATION_LIMITS, type VoiceBotVerifyReportDto } from '@tcg-live/core';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { readableText, SNOWFLAKE, UUID } from '../ops/http.js';
import { broadPermissionWarnings, discordHelperApi, offlineHelperApi, type HelperDiscordApi } from './helper-api.js';
import { helperInviteUrl } from './pool.js';

export const DEFAULT_VOICE_BOTS_FILE = fileURLToPath(new URL('../../../../data/voice-bots.json', import.meta.url));

export interface VoiceBotSummary {
  id: string; label: string; userId: string | null; addedAtMs: number;
  applicationId: string | null; enabled: boolean; nickname: string | null;
}
/** Internal only: hand to the voice runtime, never serialize. */
export interface VoiceBotCredential extends VoiceBotSummary { token: string }
export interface VoiceBotPatch { label?: unknown; enabled?: unknown; nickname?: unknown }

interface SavedFile { version: 2; bots: VoiceBotCredential[] }

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

/** Basic shape check only; Discord itself confirms the token (probe). */
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

/** null (or empty) keeps the username. Discord refuses some words and characters in nicknames. */
export function validateBotNickname(nickname: unknown): string | null {
  if (nickname === null || (typeof nickname === 'string' && !nickname.trim())) return null;
  const max = MODERATION_LIMITS.voiceBotNicknameLength;
  if (typeof nickname !== 'string' || !readableText(nickname.trim(), max) || /[@#:]|```/.test(nickname) ||
      /^(everyone|here)$/i.test(nickname.trim()) || /discord/i.test(nickname))
    throw new OpsInputError(`A nickname is 1-${max} readable characters without @, #, : or the word "discord".`);
  return nickname.trim();
}

function parseFile(text: string): SavedFile {
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid');
  const value = raw as Record<string, unknown>;
  if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.bots)) throw new Error('invalid');
  const bots = value.bots.map(item => {
    const bot = item as Record<string, unknown>;
    if (!bot || typeof bot !== 'object' || typeof bot.id !== 'string' || !UUID.test(bot.id) ||
        typeof bot.label !== 'string' || typeof bot.token !== 'string' || !TOKEN.test(bot.token) ||
        !Number.isSafeInteger(bot.addedAtMs)) throw new Error('invalid');
    const applicationId = typeof bot.applicationId === 'string' && SNOWFLAKE.test(bot.applicationId) ? bot.applicationId : null;
    const nickname = typeof bot.nickname === 'string' && bot.nickname.trim() ? bot.nickname : null;
    return { id: bot.id, label: bot.label, token: bot.token, userId: tokenUserId(bot.token), addedAtMs: bot.addedAtMs as number,
      applicationId, enabled: bot.enabled !== false, nickname };
  });
  return { version: 2, bots };
}

const summary = ({ id, label, userId, addedAtMs, applicationId, enabled, nickname }: VoiceBotCredential): VoiceBotSummary =>
  ({ id, label, userId, addedAtMs, applicationId, enabled, nickname });

const REFUSED = 'Discord refused that token. Reset the token on the Bot page of the helper application and paste the new one.';

export class VoiceBotTokenStore {
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string = DEFAULT_VOICE_BOTS_FILE, protected readonly now: () => number = Date.now,
    protected readonly api: HelperDiscordApi = discordHelperApi()) {}

  protected async load(): Promise<SavedFile> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, bots: [] };
      throw new VoiceBotFileError('The helper bot list could not be read.');
    }
    try { return parseFile(text); }
    catch { throw new VoiceBotFileError('The saved helper bot list is invalid. Remove data/voice-bots.json and add the helper bots again.'); }
  }

  protected async save(next: SavedFile): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.voice-bots-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(temporary, this.file); break; }
        catch (error) {
          // Windows: a scanner or indexer can hold the file for a moment.
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }
    } catch {
      throw new VoiceBotFileError('The helper bot list could not be saved.');
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private transact<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(run, run);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async find(id: string): Promise<{ saved: SavedFile; bot: VoiceBotCredential }> {
    const saved = await this.load();
    const bot = typeof id === 'string' && UUID.test(id) ? saved.bots.find(item => item.id === id.toLowerCase()) : undefined;
    if (!bot) throw new OpsNotFoundError('Helper bot not found.');
    return { saved, bot };
  }

  async list(): Promise<VoiceBotSummary[]> {
    return (await this.load()).bots.map(summary);
  }

  /** Validates the token with Discord (GET /applications/@me) and stores it with its public application ID. */
  async add(label: unknown, token: unknown): Promise<VoiceBotSummary> {
    const name = validateBotLabel(label);
    const secret = validateBotToken(token);
    const userId = tokenUserId(secret);
    {
      const saved = await this.load();
      if (saved.bots.length >= MODERATION_LIMITS.voiceHelperBots)
        throw new OpsConflictError(`At most ${MODERATION_LIMITS.voiceHelperBots} helper bots can be added.`);
      if (saved.bots.some(bot => bot.token === secret || (userId !== null && bot.userId === userId)))
        throw new OpsConflictError('That helper bot is already in the list.');
    }
    const probe = await this.api.probe(secret);
    if (!probe.ok && probe.code === 'invalid-token') throw new OpsInputError(REFUSED);
    // Network trouble does not block adding; Verify fills the application ID later.
    const applicationId = probe.ok ? probe.applicationId : null;
    return this.transact(async () => {
      const saved = await this.load();
      if (saved.bots.length >= MODERATION_LIMITS.voiceHelperBots)
        throw new OpsConflictError(`At most ${MODERATION_LIMITS.voiceHelperBots} helper bots can be added.`);
      if (saved.bots.some(bot => bot.token === secret || (userId !== null && bot.userId === userId)))
        throw new OpsConflictError('That helper bot is already in the list.');
      const bot: VoiceBotCredential = { id: randomUUID(), label: name, token: secret, userId, addedAtMs: this.now(),
        applicationId, enabled: true, nickname: null };
      await this.save({ version: 2, bots: [...saved.bots, bot] });
      return summary(bot);
    });
  }

  async remove(id: string): Promise<VoiceBotSummary> {
    return this.transact(async () => {
      const { saved, bot } = await this.find(id);
      await this.save({ version: 2, bots: saved.bots.filter(item => item !== bot) });
      return summary(bot);
    });
  }

  /** Label, enabled and nickname; returns the summaries before and after. */
  async update(id: string, patch: VoiceBotPatch): Promise<{ before: VoiceBotSummary; after: VoiceBotSummary }> {
    const next: Partial<VoiceBotSummary> = {};
    if (patch.label !== undefined) next.label = validateBotLabel(patch.label);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new OpsInputError('enabled must be true or false.');
      next.enabled = patch.enabled;
    }
    if (patch.nickname !== undefined) next.nickname = validateBotNickname(patch.nickname);
    return this.transact(async () => {
      const { saved, bot } = await this.find(id);
      const updated: VoiceBotCredential = { ...bot, ...next };
      await this.save({ version: 2, bots: saved.bots.map(item => item === bot ? updated : item) });
      return { before: summary(bot), after: summary(updated) };
    });
  }

  /** Token rotation: the new token must belong to the same bot user (checked offline and with Discord). */
  async replaceToken(id: string, token: unknown): Promise<VoiceBotSummary> {
    const secret = validateBotToken(token);
    const { bot: current } = await this.find(id);
    if (tokenUserId(secret) !== current.userId)
      throw new OpsConflictError('That token belongs to a different bot. Paste the new token of this same helper application.');
    const probe = await this.api.probe(secret);
    if (!probe.ok && probe.code === 'invalid-token') throw new OpsInputError(REFUSED);
    return this.transact(async () => {
      const { saved, bot } = await this.find(id);
      if (saved.bots.some(item => item !== bot && item.token === secret)) throw new OpsConflictError('That helper bot is already in the list.');
      const updated: VoiceBotCredential = { ...bot, token: secret, applicationId: probe.ok ? probe.applicationId : bot.applicationId };
      await this.save({ version: 2, bots: saved.bots.map(item => item === bot ? updated : item) });
      return summary(updated);
    });
  }

  /** Token-free report: token valid, membership, View Channel + Connect per room, over-broad grants, nickname. */
  async verify(id: string, guildId: string, channelIds: readonly string[]): Promise<VoiceBotVerifyReportDto> {
    const { bot } = await this.find(id);
    const report: VoiceBotVerifyReportDto = { botId: bot.id, checkedAtMs: this.now(), tokenValid: false, applicationId: bot.applicationId,
      inServer: false, nickname: bot.nickname, channels: [], warnings: [], problems: [], errorCode: null,
      inviteUrl: bot.applicationId ? helperInviteUrl(bot.applicationId, guildId) : null };
    const probe = await this.api.probe(bot.token);
    if (!probe.ok) {
      report.errorCode = probe.code;
      report.problems.push(probe.code === 'invalid-token' ? REFUSED : 'Discord could not be reached. Check the internet connection and verify again.');
      return report;
    }
    report.tokenValid = true;
    report.applicationId = probe.applicationId;
    report.inviteUrl = helperInviteUrl(probe.applicationId, guildId);
    if (probe.botPublic) report.warnings.push('Public Bot is on: anyone with the link could add this helper. Turn it off on the Bot page.');
    if (probe.requireCodeGrant) report.warnings.push('Requires OAuth2 Code Grant is on: the invite link will fail. Turn it off on the Bot page.');
    if (probe.applicationId !== bot.applicationId) {
      await this.transact(async () => {
        const { saved, bot: fresh } = await this.find(id);
        await this.save({ version: 2, bots: saved.bots.map(item => item === fresh ? { ...fresh, applicationId: probe.applicationId } : item) });
      }).catch(() => {});
    }
    if (!bot.userId) return report;
    const membership = await this.api.membership(bot.token, guildId, bot.userId, channelIds);
    if (!membership.ok) {
      report.errorCode = membership.code;
      report.problems.push('The server could not be checked with this helper. Try again in a minute.');
      return report;
    }
    report.inServer = membership.inServer;
    if (!membership.inServer) {
      report.errorCode = 'not-in-server';
      report.problems.push('The helper is not in the server yet. Open its invite link and add it.');
      return report;
    }
    report.nickname = membership.nickname;
    report.channels = membership.channels;
    report.warnings.push(...broadPermissionWarnings(membership.guildPermissions));
    const missing = membership.channels.filter(channel => channel.state === 'problem').length;
    if (missing) report.problems.push(`The helper lacks View Channel or Connect in ${missing} match room${missing === 1 ? '' : 's'}.`);
    if (bot.nickname !== null && membership.nickname !== bot.nickname)
      report.warnings.push('The nickname in the server differs from the saved one; it is set again on the next login.');
    return report;
  }

  /** Sets the saved per-server nickname with the helper's own token (PATCH /guilds/{id}/members/@me). */
  async applyNickname(id: string, guildId: string): Promise<boolean> {
    const { bot } = await this.find(id);
    return (await this.api.setNickname(bot.token, guildId, bot.nickname)).ok;
  }

  /** Voice runtime only. The result holds secrets: never log, serialize or return it over HTTP. */
  async getTokens(): Promise<VoiceBotCredential[]> {
    return (await this.load()).bots.map(bot => ({ ...bot }));
  }
}

/** What the routes and the voice runtime need; VoiceBotTokenStore is the file-backed production one. */
export type VoiceBotRegistry = Pick<VoiceBotTokenStore, 'list' | 'add' | 'remove' | 'getTokens' | 'update' | 'replaceToken' |
  'verify' | 'applyNickname'>;

/** In-memory registry for tests and the demo: nothing is written to disk, Discord is never called by default. */
export class MemoryVoiceBotRegistry extends VoiceBotTokenStore {
  private saved: SavedFile = { version: 2, bots: [] };
  constructor(now: () => number = Date.now, api: HelperDiscordApi = offlineHelperApi()) { super('(memory)', now, api); }
  protected override async load(): Promise<SavedFile> { return { version: 2, bots: this.saved.bots.map(bot => ({ ...bot })) }; }
  protected override async save(next: SavedFile): Promise<void> { this.saved = { version: 2, bots: next.bots.map(bot => ({ ...bot })) }; }
}
