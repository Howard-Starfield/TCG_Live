import { Client, GatewayIntentBits, REST } from 'discord.js';

// Discord REST retries timeout/network/5xx requests, including POST by default.
// An ambiguous initial card send or command creation must not be repeated here.
/** `extraIntents` come from registered Discord features (non-privileged intents only). */
export function privateDiscordClient(publicMatchRooms = false, extraIntents: readonly GatewayIntentBits[] = []): Client {
  const intents = new Set<GatewayIntentBits>([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    ...(publicMatchRooms ? [GatewayIntentBits.GuildVoiceStates] : []), ...extraIntents]);
  return new Client({ intents: [...intents], rest: { retries: 0 } });
}

export function privateDiscordRest(token: string): REST {
  return new REST({ retries: 0 }).setToken(token);
}
