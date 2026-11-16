// Where the two bot-managed role IDs live: the setup profile (data/discord-setup.json), keyed by guild.
import type { TournamentRoleIdsDto } from '@tcg-live/core';
import { SetupProfileStore } from '../../onboarding/profile.js';

export interface TournamentRoleStore {
  /** The saved role IDs for this guild; nulls when none were saved or they belong to another guild. */
  get(guildId: string): Promise<TournamentRoleIdsDto>;
  set(value: TournamentRoleIdsDto): Promise<void>;
}

const none = (guildId: string): TournamentRoleIdsDto => ({ guildId, organizerRoleId: null, judgeRoleId: null });

/** Backed by the setup profile. A profile that cannot be read throws (never "no roles": that would invite duplicates). */
export function profileTournamentRoleStore(profile: SetupProfileStore = new SetupProfileStore()): TournamentRoleStore {
  return {
    async get(guildId) {
      const saved = (await profile.read()).roles;
      return saved && saved.guildId === guildId ? { ...saved } : none(guildId);
    },
    async set(value) { await profile.updateRoles(() => ({ ...value })); }
  };
}

/** The demo and tests: nothing touches data/. */
export class MemoryTournamentRoleStore implements TournamentRoleStore {
  private saved: TournamentRoleIdsDto | null;
  constructor(initial?: TournamentRoleIdsDto) { this.saved = initial ? { ...initial } : null; }
  async get(guildId: string): Promise<TournamentRoleIdsDto> {
    return this.saved && this.saved.guildId === guildId ? { ...this.saved } : none(guildId);
  }
  async set(value: TournamentRoleIdsDto): Promise<void> { this.saved = { ...value }; }
}
