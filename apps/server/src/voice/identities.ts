// Discord user IDs of every voice pool bot (main + helpers). match-rooms.ts consults this so a pool
// bot joining or leaving a match room never triggers room placement.
export class VoicePoolIdentities {
  private readonly ids = new Map<string, string>();
  /** Records `userId` for pool slot `botId`; null clears the slot. */
  set(botId: string, userId: string | null): void {
    if (userId) this.ids.set(botId, userId); else this.ids.delete(botId);
  }
  /** Keeps only the listed slots. */
  retain(botIds: Iterable<string>): void {
    const keep = new Set(botIds);
    for (const id of [...this.ids.keys()]) if (!keep.has(id)) this.ids.delete(id);
  }
  has(userId: string): boolean {
    for (const id of this.ids.values()) if (id === userId) return true;
    return false;
  }
  clear(): void { this.ids.clear(); }
}

/** Process-wide registry shared by the voice runtime and the match-room reconciler. */
export const voicePoolIdentities = new VoicePoolIdentities();
