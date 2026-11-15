// The `/tcg-admin` moderation subcommand definitions (agent G1), kept free of runtime imports so
// discord/admin-command.ts can list them. Handlers: discord-feature.ts.
import type { SlashCommandSubcommandBuilder } from 'discord.js';
import { ADMIN_TOOLS_LIMITS as L } from '@tcg-live/core';

interface Subcommand { name: string; description: string; build?(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder }

const member = (sub: SlashCommandSubcommandBuilder, description = 'The member') =>
  sub.addUserOption(option => option.setName('member').setDescription(description).setRequired(true));
const reasonOption = (sub: SlashCommandSubcommandBuilder) =>
  sub.addStringOption(option => option.setName('reason').setDescription('Reason (stored in the case; sent to the member by DM when enabled)')
    .setRequired(true).setMaxLength(L.reasonLength));

/** Appended to adminSubcommands (discord/admin-command.ts). */
export const MODERATION_SUBCOMMANDS: Subcommand[] = [
  { name: 'warn', description: 'Warn a member (opens a case)', build: sub => reasonOption(member(sub)) },
  { name: 'timeout', description: 'Time a member out (up to 28 days)', build: sub => reasonOption(member(sub)
    .addStringOption(option => option.setName('duration').setDescription('For example 10m, 2h, 1d').setRequired(true).setMaxLength(16))) },
  { name: 'untimeout', description: 'Lift a member\'s timeout', build: sub => reasonOption(member(sub)) },
  { name: 'kick', description: 'Kick a member', build: sub => reasonOption(member(sub)) },
  { name: 'ban', description: 'Ban a member; give a duration for a temporary ban', build: sub => reasonOption(member(sub, 'The member or user'))
    .addStringOption(option => option.setName('duration').setDescription('Temporary ban, for example 1d or 2w; leave empty for permanent').setMaxLength(16))
    .addIntegerOption(option => option.setName('delete-messages').setDescription('Delete their recent messages')
      .addChoices({ name: 'None', value: 0 }, { name: 'Last hour', value: 3_600 }, { name: 'Last 24 hours', value: 86_400 },
        { name: 'Last 7 days', value: 604_800 })) },
  { name: 'unban', description: 'Unban a user', build: sub => sub
    .addStringOption(option => option.setName('user-id').setDescription('Discord user ID of the banned user').setRequired(true).setMaxLength(32))
    .addStringOption(option => option.setName('reason').setDescription('Reason (stored in the case)').setRequired(true).setMaxLength(L.reasonLength)) },
  { name: 'case', description: 'Show a moderation case', build: sub => sub
    .addIntegerOption(option => option.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)) },
  { name: 'note', description: 'Add a private mod note to a member', build: sub => member(sub)
    .addStringOption(option => option.setName('text').setDescription('The note (only staff see it)').setRequired(true).setMaxLength(L.noteLength)) }
];

