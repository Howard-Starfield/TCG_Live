// Turns dashboard DTOs into Discord message payloads (embeds, button rows) and decides button-role clicks.
import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent, type APIEmbed } from 'discord.js';
import type { ButtonRoleButtonDto, ButtonRoleMode, ButtonStyleName, EmbedDto, MessageBodyDto } from '@tcg-live/core';
import type { OutgoingAllowedMentions, OutgoingMessage } from './guild-port.js';
import { FEATURE_INTERACTION_PREFIXES } from '../../discord/interactions.js';

export const BUTTONS_PER_ROW = 5;
const STYLES: Record<ButtonStyleName, ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger> = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger
};

export function embedToApi(embed: EmbedDto): APIEmbed {
  return {
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(embed.color !== null ? { color: embed.color } : {}),
    ...(embed.url ? { url: embed.url } : {}),
    ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}),
    ...(embed.thumbnailUrl ? { thumbnail: { url: embed.thumbnailUrl } } : {}),
    ...(embed.footer ? { footer: { text: embed.footer } } : {}),
    ...(embed.fields.length ? { fields: embed.fields.map(field => ({ name: field.name, value: field.value, inline: field.inline })) } : {})
  };
}

/** No pings unless a caller asks for them explicitly. */
export const noMentions = (): OutgoingAllowedMentions => ({ parse: [], roles: [], users: [] });

export function panelCustomId(panelId: string, roleId: string): string {
  return `${FEATURE_INTERACTION_PREFIXES.buttonRoles}${panelId}:${roleId}`;
}
export function parsePanelCustomId(customId: string): { panelId: string; roleId: string } | null {
  const match = /^br:([0-9a-f-]{36}):([1-9]\d{14,21})$/.exec(customId);
  return match ? { panelId: match[1]!, roleId: match[2]! } : null;
}

function emoji(value: string | null) {
  if (!value) return {};
  return { emoji: /^\d+$/.test(value) ? { id: value } : { name: value } };
}

/** Buttons fill rows of five, in order (25 buttons = 5 rows, Discord's maximum). */
export function buttonRows(panelId: string, buttons: readonly ButtonRoleButtonDto[]): APIActionRowComponent<APIButtonComponent>[] {
  const rows: APIActionRowComponent<APIButtonComponent>[] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
    rows.push({ type: ComponentType.ActionRow, components: buttons.slice(index, index + BUTTONS_PER_ROW).map(button => ({
      type: ComponentType.Button, style: STYLES[button.style], custom_id: panelCustomId(panelId, button.roleId),
      label: button.label, ...emoji(button.emoji) })) });
  }
  return rows;
}

export function panelMessage(panel: { id: string; body: MessageBodyDto; buttons: readonly ButtonRoleButtonDto[] }): OutgoingMessage {
  return { content: panel.body.content, embeds: panel.body.embed ? [embedToApi(panel.body.embed)] : [],
    components: buttonRows(panel.id, panel.buttons), allowedMentions: noMentions() };
}

export type ButtonRoleDecision =
  | { kind: 'denied'; message: string }
  | { kind: 'change'; add: string[]; remove: string[]; message: string };

/**
 * What one click does. toggle: the clicked role is added, or removed when held. unique: the clicked role
 * is added and every other role of the panel the member holds is removed; clicking the held one removes it.
 */
export function decideButtonRole(panel: { mode: ButtonRoleMode; buttons: readonly ButtonRoleButtonDto[]; requiredRoleId: string | null },
  memberRoleIds: readonly string[], roleId: string, roleName: (id: string) => string = id => `<@&${id}>`): ButtonRoleDecision {
  const button = panel.buttons.find(item => item.roleId === roleId);
  if (!button) return { kind: 'denied', message: 'This button is no longer part of the panel.' };
  if (panel.requiredRoleId && !memberRoleIds.includes(panel.requiredRoleId))
    return { kind: 'denied', message: `You need the ${roleName(panel.requiredRoleId)} role to use this panel.` };
  const held = memberRoleIds.includes(roleId);
  if (held) return { kind: 'change', add: [], remove: [roleId], message: `Removed ${roleName(roleId)}.` };
  const remove = panel.mode === 'unique'
    ? panel.buttons.map(item => item.roleId).filter(id => id !== roleId && memberRoleIds.includes(id)) : [];
  return { kind: 'change', add: [roleId], remove,
    message: remove.length ? `Added ${roleName(roleId)} and removed ${remove.map(roleName).join(', ')}.` : `Added ${roleName(roleId)}.` };
}
