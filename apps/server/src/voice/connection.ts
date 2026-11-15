// The only module that uses @discordjs/voice and opusscript. Both are loaded lazily, so the server runs
// (and every test passes) without touching them unless the voice runtime is enabled.
// Tokens: a helper token is passed to Client.login() and nowhere else. Errors from login or joining are
// swallowed into a state or a fixed message, so no library error text (which could echo input) escapes.
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import type { DiscordGatewayAdapterCreator, VoiceConnection } from '@discordjs/voice';
import type { VoiceBotErrorCode } from '@tcg-live/core';
import type { OpusDecoder, OpusDecoderFactory, VoiceBotHealth, VoiceBotLoginState, VoiceBotTransport, VoiceChannelHandle,
  VoiceConnectionPhase, VoicePacketSubscription } from './transport.js';

const READY_TIMEOUT_MS = 20_000;
const JOIN_TIMEOUT_MS = 15_000;
const RECONNECT_GRACE_MS = 5_000;
/** A connection that is not Ready again within this long after leaving Ready is destroyed (the monitor rejoins). */
export const NOT_READY_LIMIT_MS = 30_000;
/** Transient login failures retry after 30 s, doubling up to 5 min. */
export const LOGIN_RETRY_MIN_MS = 30_000;
export const LOGIN_RETRY_MAX_MS = 5 * 60_000;

export function loginBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(LOGIN_RETRY_MAX_MS, LOGIN_RETRY_MIN_MS * 2 ** Math.min(10, consecutiveFailures - 1));
}

/**
 * Sorts a login failure into a fixed code without ever reading its text: an invalid token (discord.js
 * TokenInvalid, gateway close 4004, HTTP 401) stays failed; anything else is transient and retried.
 */
export function classifyLoginError(error: unknown): VoiceBotErrorCode {
  const value = error as { code?: unknown; status?: unknown; name?: unknown } | null;
  const code = value?.code;
  if (code === 'TokenInvalid' || code === 4004 || code === 'TokenMissing' || value?.status === 401) return 'invalid-token';
  if (value?.status === 429) return 'rate-limited';
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError' || code === 'ABORT_ERR') return 'timeout';
  if (typeof code === 'string' && /^(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(code)) return 'network';
  return 'unknown';
}

type VoiceModule = typeof import('@discordjs/voice');
let voiceModule: Promise<VoiceModule> | undefined;
const loadVoice = () => voiceModule ??= import('@discordjs/voice');

/** Token-free error for every voice connection failure. */
export class VoiceJoinError extends Error {
  constructor(message = 'The voice bot could not join the match room.') { super(message); this.name = 'VoiceJoinError'; }
}

async function joinWith(guild: Guild, channelId: string, group: string): Promise<VoiceChannelHandle> {
  const voice = await loadVoice();
  let connection: VoiceConnection;
  try {
    connection = voice.joinVoiceChannel({ channelId, guildId: guild.id, group, selfMute: true, selfDeaf: false,
      adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator });
    await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
  } catch {
    voice.getVoiceConnection(guild.id, group)?.destroy();
    throw new VoiceJoinError();
  }
  const lostListeners = new Set<() => void>();
  const stateListeners = new Set<(state: VoiceConnectionPhase) => void>();
  let lost = false;
  let notReadyTimer: NodeJS.Timeout | undefined;
  const destroy = () => { try { connection.destroy(); } catch { /* already destroyed */ } };
  const markLost = () => {
    if (notReadyTimer) clearTimeout(notReadyTimer);
    if (lost) return;
    lost = true;
    for (const listener of lostListeners) { try { listener(); } catch { /* isolated */ } }
  };
  const emit = (state: VoiceConnectionPhase) => {
    if (lost) return;
    if (state === 'ready') { if (notReadyTimer) clearTimeout(notReadyTimer); notReadyTimer = undefined; }
    // Never stuck half-connected: not Ready again within the limit means destroyed, and the monitor rejoins.
    else if (!notReadyTimer) { notReadyTimer = setTimeout(destroy, NOT_READY_LIMIT_MS); notReadyTimer.unref(); }
    for (const listener of stateListeners) { try { listener(state); } catch { /* isolated */ } }
  };
  connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
    emit('disconnected');
    // A channel move or brief network loss reconnects on its own; anything else is a real loss.
    void Promise.race([voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
      voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS)])
      .catch(destroy);
  });
  connection.on(voice.VoiceConnectionStatus.Signalling, () => emit('signalling'));
  connection.on(voice.VoiceConnectionStatus.Connecting, () => emit('connecting'));
  connection.on(voice.VoiceConnectionStatus.Ready, () => emit('ready'));
  connection.on(voice.VoiceConnectionStatus.Destroyed, markLost);
  connection.on('error', () => { /* Surfaced as Disconnected/Destroyed; never log library text. */ });
  const subscriptions = new Map<string, VoicePacketSubscription>();
  return {
    channelId,
    subscribe(userId, onPacket) {
      const existing = subscriptions.get(userId);
      if (existing) return existing;
      const stream = connection.receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.Manual } });
      const listener = (packet: Buffer) => { try { onPacket(packet); } catch { /* A consumer bug never kills the stream. */ } };
      stream.on('data', listener);
      stream.on('error', () => {});
      const subscription = { close() { subscriptions.delete(userId); stream.off('data', listener); stream.destroy(); } };
      subscriptions.set(userId, subscription);
      return subscription;
    },
    onLost(listener) { if (lost) listener(); else lostListeners.add(listener); },
    onState(listener) { stateListeners.add(listener); },
    leave() {
      for (const subscription of [...subscriptions.values()]) subscription.close();
      lostListeners.clear();
      stateListeners.clear();
      if (notReadyTimer) clearTimeout(notReadyTimer);
      try { connection.destroy(); } catch { /* already destroyed */ }
    }
  };
}

/** The main bot: reuses the runtime's logged-in client (one voice connection per guild for it). */
export class MainBotTransport implements VoiceBotTransport {
  constructor(readonly botId: string, private readonly client: Client, private readonly guildId: string) {}
  userId() { return this.client.user?.id ?? null; }
  state(): VoiceBotLoginState {
    if (!this.client.isReady()) return 'logging-in';
    return this.client.guilds.cache.has(this.guildId) ? 'ready' : 'not in server';
  }
  async ensureReady() { return this.state(); }
  async join(channelId: string) {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new VoiceJoinError();
    return joinWith(guild, channelId, this.botId);
  }
  async destroy() {
    const voice = await loadVoice().catch(() => null);
    voice?.getVoiceConnection(this.guildId, this.botId)?.destroy();
  }
}

/** A helper bot: its own minimal client (Guilds + GuildVoiceStates), logged in on first need. */
export class HelperBotTransport implements VoiceBotTransport {
  private client: Client | null = null;
  private status: VoiceBotLoginState = 'idle';
  private pending: Promise<VoiceBotLoginState> | null = null;
  private readonly healthState: VoiceBotHealth = { lastReadyAtMs: null, lastErrorCode: null, consecutiveFailures: 0, nextRetryAtMs: null };
  #token: string;

  constructor(readonly botId: string, token: string, private readonly guildId: string, private readonly knownUserId: string | null,
    private readonly nickname: string | null = null, private readonly now: () => number = Date.now) {
    this.#token = token;
  }
  userId() { return this.client?.user?.id ?? this.knownUserId; }
  state() { return this.status; }
  health(): VoiceBotHealth { return { ...this.healthState }; }
  resetFailure(): void {
    if (this.status === 'login failed' || this.status === 'not in server') this.status = 'idle';
    this.healthState.nextRetryAtMs = null;
  }
  /** Never serialized with its secret. */
  toJSON() { return { botId: this.botId, status: this.status }; }

  ensureReady(): Promise<VoiceBotLoginState> {
    if (this.status === 'ready' || this.status === 'login failed' || this.status === 'not in server') return Promise.resolve(this.status);
    // A transient failure waits out its backoff (30 s doubling to 5 min) instead of hammering Discord.
    if (!this.pending && this.healthState.nextRetryAtMs !== null && this.now() < this.healthState.nextRetryAtMs) return Promise.resolve(this.status);
    this.pending ??= this.login().finally(() => { this.pending = null; });
    return this.pending;
  }

  private fail(code: VoiceBotErrorCode): VoiceBotLoginState {
    this.healthState.lastErrorCode = code;
    this.healthState.consecutiveFailures += 1;
    if (code === 'invalid-token') { this.healthState.nextRetryAtMs = null; this.status = 'login failed'; }
    else if (code === 'not-in-server') { this.healthState.nextRetryAtMs = null; this.status = 'not in server'; }
    else { this.healthState.nextRetryAtMs = this.now() + loginBackoffMs(this.healthState.consecutiveFailures); this.status = 'idle'; }
    return this.status;
  }

  private async login(): Promise<VoiceBotLoginState> {
    this.status = 'logging-in';
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], rest: { retries: 1 } });
    this.client = client;
    client.on('error', () => {});
    try {
      const ready = once(client, Events.ClientReady, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
      await client.login(this.#token);
      await ready;
    } catch (error) {
      await client.destroy().catch(() => {});
      // destroy() during the login already reset this transport; do not mark it failed.
      if (this.client !== client) return this.status;
      this.client = null;
      return this.fail(classifyLoginError(error));
    }
    try { await client.guilds.fetch(this.guildId); } catch { /* Checked below. */ }
    // destroy() ran while logging in (helper removed or shutdown): never keep a live gateway client.
    if (this.client !== client) { await client.destroy().catch(() => {}); return this.status; }
    if (!client.guilds.cache.has(this.guildId)) {
      this.client = null;
      await client.destroy().catch(() => {});
      return this.fail('not-in-server');
    }
    this.status = 'ready';
    Object.assign(this.healthState, { lastReadyAtMs: this.now(), consecutiveFailures: 0, lastErrorCode: null, nextRetryAtMs: null });
    // Per-server nickname, best effort, set by the helper itself (PATCH /guilds/{id}/members/@me).
    const nickname = this.nickname;
    if (nickname !== null) {
      void client.guilds.cache.get(this.guildId)?.members.fetchMe()
        .then(me => me.nickname === nickname ? undefined : me.setNickname(nickname)).catch(() => {});
    }
    return this.status;
  }

  async join(channelId: string) {
    const guild = this.client?.guilds.cache.get(this.guildId);
    if (!guild || this.status !== 'ready') throw new VoiceJoinError();
    return joinWith(guild, channelId, this.botId);
  }

  async destroy() {
    const voice = await loadVoice().catch(() => null);
    voice?.getVoiceConnection(this.guildId, this.botId)?.destroy();
    const client = this.client;
    this.client = null;
    this.status = 'idle';
    await client?.destroy().catch(() => {});
  }
}

/** opusscript (WebAssembly) decoder: 48 kHz stereo, interleaved 16-bit. */
export function opusscriptDecoderFactory(): OpusDecoderFactory {
  const require = createRequire(import.meta.url);
  const OpusScript = require('opusscript') as typeof import('opusscript');
  return (): OpusDecoder => {
    const codec = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    return {
      decode(packet) {
        const pcm = codec.decode(packet);
        const out = new Int16Array(pcm.length >> 1);
        for (let index = 0; index < out.length; index += 1) out[index] = pcm.readInt16LE(index * 2);
        return out;
      },
      delete() { codec.delete(); }
    };
  };
}

/** `@discordjs/voice` dependency report (for diagnostics: shows opusscript, aes-256-gcm and DAVE). */
export async function voiceDependencyReport(): Promise<string> {
  return (await loadVoice()).generateDependencyReport();
}
