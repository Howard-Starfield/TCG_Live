// Discord payloads for LFG (pure, raw API JSON so tests read them directly): the sticky panel, the form
// (a modal with select menus where lists exist), and the card with Join / Leave / Close.
import { ButtonStyle, ComponentType, TextInputStyle, type APIEmbed } from 'discord.js';
import { clipLfg, LFG_LIMITS as L, lfgTemplateValues, renderLfgTemplate, type LfgPanelDto, type LfgPostDto,
  type LfgSettingsBodyDto } from '@tcg-live/core';
import type { OutgoingAllowedMentions } from '../roles/guild-port.js';
import type { LfgChannelConfig } from './settings.js';

/** Custom IDs under the reserved 'lfg:' prefix (discord/interactions.ts). */
export const LFG_IDS = {
  new: 'lfg:new',
  form: 'lfg:form',
  join: (postId: string) => `lfg:join:${postId}`,
  leave: (postId: string) => `lfg:leave:${postId}`,
  close: (postId: string) => `lfg:close:${postId}`,
  field: { game: 'lfg-game', format: 'lfg-format', note: 'lfg-note', voice: 'lfg-voice' }
} as const;

export type LfgCustomId = { action: 'new' } | { action: 'form' } | { action: 'join' | 'leave' | 'close'; postId: string };
export function parseLfgCustomId(customId: string): LfgCustomId | null {
  if (customId === LFG_IDS.new) return { action: 'new' };
  if (customId === LFG_IDS.form) return { action: 'form' };
  const match = /^lfg:(join|leave|close):([0-9a-f-]{36})$/i.exec(customId);
  return match ? { action: match[1] as 'join' | 'leave' | 'close', postId: match[2]!.toLowerCase() } : null;
}

/** A Discord message as LFG sends or edits it. Components are raw API JSON. */
export interface LfgMessage {
  content?: string;
  embeds: APIEmbed[];
  components: unknown[];
  allowedMentions: OutgoingAllowedMentions;
}

const noMentions = (): OutgoingAllowedMentions => ({ parse: [], roles: [], users: [] });
const emoji = (value: string | null) => !value ? {} : { emoji: /^\d+$/.test(value) ? { id: value } : { name: value } };

export function lfgPanelMessage(panel: LfgPanelDto): LfgMessage {
  return {
    embeds: [{ title: panel.title, description: panel.text, ...(panel.color !== null ? { color: panel.color } : {}) }],
    components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, custom_id: LFG_IDS.new, style: ButtonStyle.Success,
      label: panel.buttonLabel, ...emoji(panel.emoji) }] }],
    allowedMentions: noMentions()
  };
}

/** Voice room names for the form; unknown IDs fall back to the ID. */
export type VoiceNames = ReadonlyMap<string, string>;

const label = (text: string, component: Record<string, unknown>, description?: string) =>
  ({ type: ComponentType.Label, label: clipLfg(text, L.modalLabelLength), ...(description ? { description } : {}), component });

/** The form. Games, formats and voice rooms become select menus when the admin listed them; else text inputs. */
export function lfgModal(settings: LfgSettingsBodyDto, config: LfgChannelConfig, voiceNames: VoiceNames): Record<string, unknown> {
  const f = settings.form;
  const components: unknown[] = [];
  components.push(label(f.gameLabel, config.games.length
    ? { type: ComponentType.StringSelect, custom_id: LFG_IDS.field.game, placeholder: f.gamePlaceholder, min_values: 1, max_values: 1, required: true,
      options: config.games.slice(0, 25).map(game => ({ label: clipLfg(game.name, 100), value: game.name, ...emoji(game.emoji) })) }
    : { type: ComponentType.TextInput, custom_id: LFG_IDS.field.game, style: TextInputStyle.Short, placeholder: f.gamePlaceholder,
      required: true, min_length: 1, max_length: L.gameNameLength }));
  components.push(label(f.formatLabel, settings.formats.length
    ? { type: ComponentType.StringSelect, custom_id: LFG_IDS.field.format, placeholder: f.formatPlaceholder, min_values: 0, max_values: 1,
      required: false, options: settings.formats.slice(0, 25).map(format => ({ label: clipLfg(format, 100), value: format })) }
    : { type: ComponentType.TextInput, custom_id: LFG_IDS.field.format, style: TextInputStyle.Short, placeholder: f.formatPlaceholder,
      required: false, max_length: L.formatLength }));
  components.push(label(f.noteLabel, { type: ComponentType.TextInput, custom_id: LFG_IDS.field.note, style: TextInputStyle.Paragraph,
    placeholder: f.notePlaceholder, required: false, max_length: L.noteLength }));
  if (config.voiceChannelIds.length) components.push(label(f.voiceLabel, { type: ComponentType.StringSelect, custom_id: LFG_IDS.field.voice,
    placeholder: f.voicePlaceholder, min_values: 0, max_values: 1, required: false,
    options: config.voiceChannelIds.slice(0, 25).map(id => ({ label: clipLfg(`🔊 ${voiceNames.get(id) ?? id}`, 100), value: id })) }));
  return { custom_id: LFG_IDS.form, title: f.title, components };
}

/** What the member submitted (before validation). */
export interface LfgFormValues { game: string; format: string; note: string; voice: string }

export type LfgFormResult = { ok: true; game: string; format: string | null; note: string | null; voiceChannelId: string | null } | { ok: false; message: string };

/** Validates a submission against the channel's lists (a select can be forged, a typed game must match). */
export function parseLfgForm(values: LfgFormValues, settings: LfgSettingsBodyDto, config: LfgChannelConfig): LfgFormResult {
  const single = (value: string) => value.replace(/\s+/g, ' ').trim();
  let game = single(values.game);
  if (!game || [...game].length > L.gameNameLength || /[\p{Cc}\p{Cf}]/u.test(game)) return { ok: false, message: 'Choose a game.' };
  if (config.games.length) {
    const found = config.games.find(item => item.name.toLowerCase() === game.toLowerCase());
    if (!found) return { ok: false, message: `Pick one of these games: ${config.games.map(item => item.name).join(', ')}.`.slice(0, 1800) };
    game = found.name;
  }
  let format: string | null = single(values.format) || null;
  if (format && ([...format].length > L.formatLength || /[\p{Cc}\p{Cf}]/u.test(format))) return { ok: false, message: 'That format is too long.' };
  if (format && settings.formats.length) {
    const found = settings.formats.find(item => item.toLowerCase() === format!.toLowerCase());
    if (!found) return { ok: false, message: 'Pick one of the listed formats.' };
    format = found;
  }
  const note = values.note.replace(/\r\n/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, match => match === '\n' ? match : '').replace(/\n{3,}/g, '\n\n').trim() || null;
  if (note && [...note].length > L.noteLength) return { ok: false, message: `The note can be at most ${L.noteLength} characters.` };
  const voice = values.voice.trim() || null;
  if (voice && !config.voiceChannelIds.includes(voice)) return { ok: false, message: 'Pick one of the listed voice rooms.' };
  return { ok: true, game, format, note, voiceChannelId: voice };
}

const ACTIVE_STATES = new Set(['posting', 'open']);

/** The card: the template, the players, Join / Leave / Close (disabled once closed). Never pings when edited. */
export function lfgCardMessage(post: LfgPostDto, settings: LfgSettingsBodyDto): LfgMessage {
  const m = settings.messages;
  const values = lfgTemplateValues(post, settings.playerListLimit);
  const active = ACTIVE_STATES.has(post.status);
  const body = active ? m.cardBody : post.status === 'expired' ? m.expiredText : m.closedText;
  const embed: APIEmbed = { title: clipLfg(renderLfgTemplate(m.cardTitle, values), L.cardTitleLength) || post.game,
    description: clipLfg(renderLfgTemplate(body, values), L.cardBodyLength) || '​',
    ...(active ? (m.cardColor !== null ? { color: m.cardColor } : {}) : { color: 0x4e5058 }),
    ...(active ? {} : { footer: { text: post.status === 'expired' ? 'Expired' : 'Closed' } }) };
  const button = (id: string, text: string, style: ButtonStyle) => ({ type: ComponentType.Button, custom_id: id, label: text, style, disabled: !active });
  return {
    embeds: [embed],
    components: [{ type: ComponentType.ActionRow, components: [button(LFG_IDS.join(post.id), m.joinLabel, ButtonStyle.Success),
      button(LFG_IDS.leave(post.id), m.leaveLabel, ButtonStyle.Secondary), button(LFG_IDS.close(post.id), m.closeLabel, ButtonStyle.Danger)] }],
    allowedMentions: noMentions()
  };
}

/** The first send: the card plus the ping line when a role is pinged. Only that role can be notified. */
export function lfgFirstMessage(post: LfgPostDto, settings: LfgSettingsBodyDto): LfgMessage {
  const card = lfgCardMessage(post, settings);
  if (!post.pingedRoleId) return card;
  const content = clipLfg(renderLfgTemplate(settings.messages.pingText, lfgTemplateValues(post, settings.playerListLimit, post.pingedRoleId)), L.contentLength);
  return { ...card, content, allowedMentions: { parse: [], roles: [post.pingedRoleId], users: [] } };
}

/** A private answer from a reply template. */
export function lfgReply(template: string, post: LfgPostDto, settings: LfgSettingsBodyDto): string {
  return clipLfg(renderLfgTemplate(template, lfgTemplateValues(post, settings.playerListLimit)), L.contentLength);
}
