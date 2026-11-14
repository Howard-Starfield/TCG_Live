// The narrow seam between the voice runtime and @discordjs/voice + opusscript. Everything above this
// interface (pool assignment, recorder, loudness) runs against fakes in tests; connection.ts is the only
// module that touches the real libraries.

export interface VoicePacketSubscription { close(): void }

/** A joined voice channel. */
export interface VoiceChannelHandle {
  readonly channelId: string;
  /** Receives the Opus packets of one user only. Never call this for anyone but a seated player. */
  subscribe(userId: string, onPacket: (packet: Buffer) => void): VoicePacketSubscription;
  /** Fires once if the connection drops for good (kicked, channel deleted, reconnect failed). */
  onLost(listener: () => void): void;
  leave(): void;
}

export type VoiceBotLoginState = 'idle' | 'logging-in' | 'ready' | 'login failed' | 'not in server';

/** One voice-capable Discord identity: the main bot or a helper bot. */
export interface VoiceBotTransport {
  readonly botId: string;
  /** Discord user ID once known (decoded from the token or from the logged-in client). */
  userId(): string | null;
  state(): VoiceBotLoginState;
  /** Logs in if needed; resolves to the resulting state and never rejects. */
  ensureReady(): Promise<VoiceBotLoginState>;
  /** Joins with selfMute true and selfDeaf false. Rejects with a token-free error. */
  join(channelId: string): Promise<VoiceChannelHandle>;
  /** Leaves any channel and logs out (helpers) or detaches (main bot). Never rejects. */
  destroy(): Promise<void>;
}

export interface OpusDecoder {
  /** One packet to interleaved 16-bit PCM at 48 kHz. Throws on a corrupt packet. */
  decode(packet: Buffer): Int16Array;
  delete(): void;
}
export type OpusDecoderFactory = () => OpusDecoder;
