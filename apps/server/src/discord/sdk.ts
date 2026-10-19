import { Client, GatewayIntentBits, REST } from 'discord.js';

// Discord REST retries timeout/network/5xx requests, including POST by default.
// An ambiguous initial card send or command creation must not be repeated here.
export function privateDiscordClient(publicMatchRooms = false): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    ...(publicMatchRooms ? [GatewayIntentBits.GuildVoiceStates] : [])], rest: { retries: 0 } });
}

export function privateDiscordRest(token: string): REST {
  return new REST({ retries: 0 }).setToken(token);
}
