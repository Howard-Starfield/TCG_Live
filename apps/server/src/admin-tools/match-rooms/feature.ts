// Room chat transcripts keep message text only with the Message Content intent. With public match rooms on, the runtime asks for
// it the way tickets and the message log do (opt-in, privileged): if Discord refuses it, transcripts keep the author, time and
// attachments, and the dashboard says so.
import { GatewayIntentBits } from 'discord.js';
import type { DiscordFeature } from '../../discord/features.js';

export function matchRoomChatFeature(): DiscordFeature {
  return { name: 'match-room-chat', intents: [GatewayIntentBits.MessageContent], start() {}, stop() {} };
}
