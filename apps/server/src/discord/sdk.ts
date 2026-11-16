import { Client, GatewayIntentBits, REST } from 'discord.js';

/** Intents every private Discord runtime requests, before features add theirs. */
export function baseIntents(publicMatchRooms = false): GatewayIntentBits[] {
  return [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(publicMatchRooms ? [GatewayIntentBits.GuildVoiceStates] : [])];
}

// Discord REST retries timeout/network/5xx requests, including POST by default.
// An ambiguous initial card send or command creation must not be repeated here.
/** `extraIntents` come from registered Discord features (privileged ones only via planIntents in intents.ts). */
export function privateDiscordClient(publicMatchRooms = false, extraIntents: readonly GatewayIntentBits[] = []): Client {
  const intents = new Set<GatewayIntentBits>([...baseIntents(publicMatchRooms), ...extraIntents]);
  return new Client({ intents: [...intents], rest: { retries: 0 } });
}

export function privateDiscordRest(token: string): REST {
  return new REST({ retries: 0 }).setToken(token);
}

/**
 * The REST instance room renames use (admin-tools/match-rooms/renames.ts). Discord allows 2 renames per 10 minutes per
 * channel, and a client REST instance would wait out a limited route for up to 10 minutes, so this one rejects at once
 * (`rejectOnRateLimit`) and the rename queue decides when to try again. Never rename through `channel.setName` or
 * `channel.edit({ name })`: those use the client's own REST.
 */
export function matchRoomRenameRest(token: string): REST {
  return new REST({ retries: 0, rejectOnRateLimit: () => true }).setToken(token);
}
