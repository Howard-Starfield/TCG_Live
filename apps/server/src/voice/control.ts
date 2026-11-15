// Process-wide handle on the running voice monitor (like voicePoolIdentities): the dashboard routes ask it
// to retry a helper without the runtime having to wire a new callback. Detached means voice is off.

export interface VoiceRuntimeControlTarget {
  /** Clears a helper's login failure and backoff and logs it in again if a room needs it. False if unknown. */
  retryBot(botId: string): Promise<boolean>;
}

export class VoiceRuntimeControl {
  private target: VoiceRuntimeControlTarget | null = null;
  attach(target: VoiceRuntimeControlTarget): void { this.target = target; }
  detach(target: VoiceRuntimeControlTarget): void { if (this.target === target) this.target = null; }
  get running(): boolean { return this.target !== null; }
  async retryBot(botId: string): Promise<boolean> { return this.target ? this.target.retryBot(botId) : false; }
}

export const voiceRuntimeControl = new VoiceRuntimeControl();
