// Discord message bodies and permission overwrites for tickets. Pure (no I/O) so tests check them directly.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, type BaseMessageOptions } from 'discord.js';
import type { EmbedDto, MessageBodyDto, TicketDto, TicketPanelDto, TranscriptMessageDto } from '@tcg-live/core';

/** Custom IDs under the reserved 'tk:' prefix (discord/interactions.ts). */
export const TICKET_IDS = {
  open: 'tk:open',
  close: (ticketId: string) => `tk:close:${ticketId}`,
  confirm: (ticketId: string) => `tk:confirm:${ticketId}`,
  cancel: 'tk:cancel',
  claim: (ticketId: string) => `tk:claim:${ticketId}`
} as const;

export type TicketCustomId =
  | { action: 'open' } | { action: 'cancel' }
  | { action: 'close' | 'confirm' | 'claim'; ticketId: string };
export function parseTicketCustomId(customId: string): TicketCustomId | null {
  if (customId === TICKET_IDS.open) return { action: 'open' };
  if (customId === TICKET_IDS.cancel) return { action: 'cancel' };
  const match = /^tk:(close|confirm|claim):([0-9a-f-]{36})$/i.exec(customId);
  return match ? { action: match[1] as 'close' | 'confirm' | 'claim', ticketId: match[2]!.toLowerCase() } : null;
}

/** `ticket-{name}-{n}` with a Discord-safe member name. */
export function ticketChannelName(pattern: string, username: string, number: number): string {
  const name = username.toLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'member';
  return pattern.replaceAll('{name}', name).replaceAll('{n}', String(number)).replace(/[^a-z0-9_-]+/g, '-').slice(0, 100);
}

export interface OverwriteSpec { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint }

const PARTICIPANT = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;
// Only bits the bot needs: Discord refuses (50013) an overwrite that allows a permission the bot itself lacks.
const BOT = PARTICIPANT | PermissionFlagsBits.ManageChannels;

/** @everyone cannot see the ticket; the member, the staff roles and the bot can. */
export function ticketOverwrites(input: { everyoneRoleId: string; openerId: string; staffRoleIds: readonly string[]; botUserId: string | null }): OverwriteSpec[] {
  return [
    { id: input.everyoneRoleId, type: 'role', allow: 0n, deny: PermissionFlagsBits.ViewChannel },
    { id: input.openerId, type: 'member', allow: PARTICIPANT, deny: 0n },
    ...[...new Set(input.staffRoleIds)].filter(id => id !== input.everyoneRoleId).map(id => ({ id, type: 'role' as const, allow: PARTICIPANT, deny: 0n })),
    ...(input.botUserId ? [{ id: input.botUserId, type: 'member' as const, allow: BOT, deny: 0n }] : [])
  ];
}

export function embedFromDto(dto: EmbedDto): EmbedBuilder {
  const embed = new EmbedBuilder();
  if (dto.title) embed.setTitle(dto.title);
  if (dto.description) embed.setDescription(dto.description);
  if (dto.color !== null) embed.setColor(dto.color);
  if (dto.url) embed.setURL(dto.url);
  if (dto.imageUrl) embed.setImage(dto.imageUrl);
  if (dto.thumbnailUrl) embed.setThumbnail(dto.thumbnailUrl);
  if (dto.footer) embed.setFooter({ text: dto.footer });
  if (dto.fields.length) embed.addFields(dto.fields);
  return embed;
}

/** A sticky body as Discord message options; mentions never ping. */
export function messageFromBody(body: MessageBodyDto): BaseMessageOptions {
  return { ...(body.content ? { content: body.content } : {}), embeds: body.embed ? [embedFromDto(body.embed)] : [], allowedMentions: { parse: [] } };
}

export function ticketPanelMessage(panel: TicketPanelDto): BaseMessageOptions {
  const embed = new EmbedBuilder().setTitle(panel.title).setDescription(panel.text);
  if (panel.color !== null) embed.setColor(panel.color);
  const button = new ButtonBuilder().setCustomId(TICKET_IDS.open).setLabel(panel.buttonLabel).setStyle(ButtonStyle.Primary);
  if (panel.emoji) button.setEmoji(/^\d+$/.test(panel.emoji) ? { id: panel.emoji } : { name: panel.emoji });
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)], allowedMentions: { parse: [] } };
}

export function ticketWelcomeMessage(ticket: Pick<TicketDto, 'id' | 'number' | 'openerId'>, staffRoleIds: readonly string[], reopened = false): BaseMessageOptions {
  const staff = staffRoleIds.map(id => `<@&${id}>`).join(' ');
  return {
    content: `<@${ticket.openerId}>${staff ? ` ${staff}` : ''}`,
    embeds: [new EmbedBuilder().setTitle(`Ticket #${ticket.number}${reopened ? ' (reopened)' : ''}`)
      .setDescription('Describe your issue and a staff member will answer here. Press **Close** when you are done; a transcript is kept for the staff.')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TICKET_IDS.close(ticket.id)).setLabel('Close').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(TICKET_IDS.claim(ticket.id)).setLabel('Claim (staff)').setStyle(ButtonStyle.Secondary))],
    // Only the member and the staff roles are pinged.
    allowedMentions: { users: [ticket.openerId], roles: [...staffRoleIds] }
  };
}

export function ticketCloseConfirmMessage(ticketId: string): BaseMessageOptions {
  return { content: 'Close this ticket? The channel is deleted and a transcript is saved for the staff.',
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TICKET_IDS.confirm(ticketId)).setLabel('Close ticket').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(TICKET_IDS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] };
}

/** The transcript tail posted into a reopened ticket (fits one Discord message). */
export function transcriptSummary(number: number, messages: readonly Pick<TranscriptMessageDto, 'authorName' | 'content' | 'attachments' | 'createdAtMs'>[]): string {
  const header = `Ticket #${number} was reopened by the staff. Last messages before it was closed:`;
  if (!messages.length) return `Ticket #${number} was reopened by the staff. No transcript was saved.`;
  const lines: string[] = [];
  let length = header.length;
  for (const message of [...messages].reverse()) {
    const text = message.content.trim() || (message.attachments.length ? `[${message.attachments.length} attachment(s)]` : '[text not available]');
    const line = `> **${message.authorName.replace(/[*_`~|>]/g, '')}** <t:${Math.floor(message.createdAtMs / 1000)}:t>: ${text.replace(/\s+/g, ' ').slice(0, 300)}`;
    if (length + line.length + 1 > 1900) break;
    lines.unshift(line);
    length += line.length + 1;
  }
  return [header, ...lines].join('\n');
}
