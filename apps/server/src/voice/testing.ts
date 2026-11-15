import type { OpusDecoder, VoiceBotLoginState, VoiceBotTransport, VoiceChannelHandle, VoiceConnectionPhase, VoicePacketSubscription } from './transport.js';

/** Synthetic token with a real-looking shape; built at runtime so no token-like literal is committed. */
export function syntheticToken(userId = '123456789012345678', tail = 'x'): string {
  return `${Buffer.from(userId).toString('base64url')}.AbCdEf.${tail.repeat(38)}`;
}

/** A joined fake voice channel: tests push packets with emit() and drop it with lose(). */
export class FakeChannelHandle implements VoiceChannelHandle {
  readonly listeners = new Map<string, (packet: Buffer) => void>();
  readonly subscribed: string[] = [];
  left = false;
  private lost: Array<() => void> = [];
  private states: Array<(state: VoiceConnectionPhase) => void> = [];
  constructor(readonly channelId: string) {}
  subscribe(userId: string, onPacket: (packet: Buffer) => void): VoicePacketSubscription {
    this.subscribed.push(userId);
    this.listeners.set(userId, onPacket);
    return { close: () => { this.listeners.delete(userId); } };
  }
  onLost(listener: () => void) { this.lost.push(listener); }
  onState(listener: (state: VoiceConnectionPhase) => void) { this.states.push(listener); }
  /** Simulates a connection state change (disconnected, signalling, connecting, ready). */
  setState(state: VoiceConnectionPhase) { for (const listener of this.states) listener(state); }
  leave() { this.left = true; this.listeners.clear(); }
  /** Delivers a packet as Discord would; packets for unsubscribed users are dropped like the real receiver. */
  emit(userId: string, packet: Buffer) { this.listeners.get(userId)?.(packet); }
  lose() { for (const listener of this.lost) listener(); }
}

export class FakeVoiceBot implements VoiceBotTransport {
  readonly handles: FakeChannelHandle[] = [];
  loginCalls = 0;
  destroyed = 0;
  failJoin = false;
  private status: VoiceBotLoginState;
  constructor(readonly botId: string, private readonly user: string | null, public loginResult: VoiceBotLoginState = 'ready',
    initial: VoiceBotLoginState = 'idle') { this.status = initial; }
  userId() { return this.user; }
  state() { return this.status; }
  async ensureReady() { this.loginCalls += 1; this.status = this.loginResult; return this.status; }
  async join(channelId: string) {
    if (this.failJoin) throw new Error('The voice bot could not join the match room.');
    const handle = new FakeChannelHandle(channelId);
    this.handles.push(handle);
    return handle;
  }
  async destroy() { this.destroyed += 1; this.status = 'idle'; }
  resets = 0;
  resetFailure() { this.resets += 1; if (this.status === 'login failed') this.status = 'idle'; }
  /** The currently joined channel, if any. */
  get active(): FakeChannelHandle | undefined { return this.handles.filter(handle => !handle.left).at(-1); }
}

/** Decoder that maps a packet to PCM given by `pcmFor` (default: the packet's first byte as level). */
export function fakeDecoder(pcmFor: (packet: Buffer) => Int16Array): () => OpusDecoder {
  return () => ({ decode: pcmFor, delete() {} });
}
