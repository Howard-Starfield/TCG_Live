// Strict validators shared by every admin-tools route and store. Each throws OpsInputError with a message
// that is safe to show (mapped to 400 by mapOpsError). Feature agents import these instead of copying them.
import { ADMIN_TOOLS_LIMITS as L, BUTTON_STYLES, type ButtonStyleName, type EmbedDto, type EmbedFieldDto,
  type MessageBodyDto } from '@tcg-live/core';
import { OpsInputError } from '../ops/errors.js';
import { readableText, SNOWFLAKE, UUID } from '../ops/http.js';

export const fail = (message: string): never => { throw new OpsInputError(message); };

/** An object with exactly these keys (no unknown, none missing). */
export function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) fail(`${label} has unknown fields.`);
  if (keys.some(key => !Object.hasOwn(record, key))) fail(`${label} is missing fields.`);
  return record;
}
/** Like exactObject, but `optional` keys may be absent. */
export function shapedObject(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) fail(`${label} has unknown fields.`);
  if (required.some(key => !Object.hasOwn(record, key))) fail(`${label} is missing fields.`);
  return record;
}
export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value as boolean;
}
export function int(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${label} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
export function oneOf<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(`Choose a valid ${label}.`);
  return value as T;
}
export function snowflake(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) fail(`${label} must be a Discord ID.`);
  return value as string;
}
export function snowflakeOrNull(value: unknown, label: string): string | null {
  return value === null ? null : snowflake(value, label);
}
/** De-duplicated list of Discord IDs. */
export function snowflakeList(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} Discord IDs.`);
  const items = value as unknown[];
  if (items.some(item => typeof item !== 'string' || !SNOWFLAKE.test(item))) fail(`${label} must contain Discord IDs only.`);
  return [...new Set(items as string[])];
}
export function uuidList(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} IDs.`);
  const items = value as unknown[];
  if (items.some(item => typeof item !== 'string' || !UUID.test(item))) fail(`${label} must contain valid IDs.`);
  return [...new Set((items as string[]).map(item => item.toLowerCase()))];
}
/** Trimmed readable text of 1..max code points (newlines only when multiline). */
export function text(value: unknown, max: number, label: string, multiline = false): string {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  const trimmed = (value as string).trim();
  if (!trimmed || !readableText(trimmed, max, multiline)) fail(`${label} must be 1-${max} readable characters.`);
  return trimmed;
}
export function textOrNull(value: unknown, max: number, label: string, multiline = false): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return text(value, max, label, multiline);
}
/** A required moderation reason (1-500 after trimming, single paragraph allowed with newlines). */
export function reason(value: unknown, label = 'Reason'): string {
  return text(value, L.reasonLength, label, true);
}
export function httpsUrlOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > L.urlLength || !/^https:\/\/[^\s]+$/.test(value)) fail(`${label} must be an https:// link.`);
  return value as string;
}
export function colorOrNull(value: unknown, label: string): number | null {
  return value === null ? null : int(value, 0, 0xffffff, label);
}
/** A Unicode emoji (short) or a custom emoji ID; null for none. */
export function emojiOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be an emoji.`);
  const emoji = (value as string).trim();
  if (SNOWFLAKE.test(emoji)) return emoji;
  if (!emoji || [...emoji].length > 8 || /[\s\p{L}]/u.test(emoji) || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u.test(emoji))
    fail(`${label} must be one emoji.`);
  return emoji;
}
export function buttonStyle(value: unknown, label: string): ButtonStyleName {
  return oneOf(value, BUTTON_STYLES, label);
}

function field(value: unknown, index: number): EmbedFieldDto {
  const item = exactObject(value, ['name', 'value', 'inline'], `Embed field ${index + 1}`);
  return { name: text(item.name, L.embedFieldNameLength, `Embed field ${index + 1} name`),
    value: text(item.value, L.embedFieldValueLength, `Embed field ${index + 1} value`, true),
    inline: bool(item.inline, `Embed field ${index + 1} inline`) };
}
/** Strict embed. Discord's 6000-character total is checked too. */
export function embed(value: unknown, label = 'Embed'): EmbedDto {
  const item = exactObject(value, ['title', 'description', 'color', 'url', 'imageUrl', 'thumbnailUrl', 'footer', 'fields'], label);
  if (!Array.isArray(item.fields) || item.fields.length > L.embedFields) fail(`${label} can have at most ${L.embedFields} fields.`);
  const result: EmbedDto = {
    title: textOrNull(item.title, L.embedTitleLength, `${label} title`),
    description: textOrNull(item.description, L.embedDescriptionLength, `${label} description`, true),
    color: colorOrNull(item.color, `${label} colour`),
    url: httpsUrlOrNull(item.url, `${label} link`),
    imageUrl: httpsUrlOrNull(item.imageUrl, `${label} image`),
    thumbnailUrl: httpsUrlOrNull(item.thumbnailUrl, `${label} thumbnail`),
    footer: textOrNull(item.footer, L.embedFooterLength, `${label} footer`),
    fields: (item.fields as unknown[]).map(field)
  };
  const total = [result.title, result.description, result.footer, ...result.fields.flatMap(entry => [entry.name, entry.value])]
    .reduce((sum, part) => sum + (part ? [...part].length : 0), 0);
  if (total > 6000) fail(`${label} is longer than Discord allows (6000 characters in total).`);
  if (!result.title && !result.description && !result.fields.length && !result.imageUrl)
    fail(`${label} needs a title, description, field or image.`);
  return result;
}
/** Content and/or embed; at least one. */
export function messageBody(value: unknown, label = 'Message'): MessageBodyDto {
  const item = exactObject(value, ['content', 'embed'], label);
  const content = textOrNull(item.content, L.messageContentLength, `${label} text`, true);
  const parsed = item.embed === null ? null : embed(item.embed, `${label} embed`);
  if (content === null && parsed === null) fail(`${label} needs text or an embed.`);
  return { content, embed: parsed };
}
