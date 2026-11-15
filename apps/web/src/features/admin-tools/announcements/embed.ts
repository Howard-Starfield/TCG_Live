// Embed helpers shared by the announcement builder and the button-role panel editor: an empty embed,
// Discord's limits checked as you type (the server checks them again), and a safe markdown subset.
import { ADMIN_TOOLS_LIMITS as L, type EmbedDto, type MessageBodyDto } from '@tcg-live/core';

export const emptyEmbed = (): EmbedDto => ({ title: null, description: null, color: null, url: null, imageUrl: null, thumbnailUrl: null,
  footer: null, fields: [] });

const length = (value: string | null) => value ? [...value].length : 0;
const httpsOk = (value: string | null) => value === null || (/^https:\/\/\S+$/.test(value) && value.length <= L.urlLength);

/** Characters counted towards Discord's 6000 total. */
export function embedTotal(embed: EmbedDto): number {
  return length(embed.title) + length(embed.description) + length(embed.footer)
    + embed.fields.reduce((sum, field) => sum + length(field.name) + length(field.value), 0);
}

export type EmbedProblems = Partial<Record<'title' | 'description' | 'footer' | 'fields' | 'total' | 'imageUrl' | 'thumbnailUrl' | 'url' | 'empty', string>>;

export function embedProblems(embed: EmbedDto): EmbedProblems {
  const problems: EmbedProblems = {};
  if (length(embed.title) > L.embedTitleLength) problems.title = `Title is ${length(embed.title)}/${L.embedTitleLength} characters.`;
  if (length(embed.description) > L.embedDescriptionLength)
    problems.description = `Description is ${length(embed.description)}/${L.embedDescriptionLength} characters.`;
  if (length(embed.footer) > L.embedFooterLength) problems.footer = `Footer is longer than ${L.embedFooterLength} characters.`;
  if (embed.fields.length > L.embedFields) problems.fields = `At most ${L.embedFields} fields.`;
  else if (embed.fields.some(field => !field.name.trim() || !field.value.trim())) problems.fields = 'Every field needs a name and a value.';
  else if (embed.fields.some(field => length(field.name) > L.embedFieldNameLength || length(field.value) > L.embedFieldValueLength))
    problems.fields = `Field names are at most ${L.embedFieldNameLength} and values ${L.embedFieldValueLength} characters.`;
  if (embedTotal(embed) > 6000) problems.total = `The embed has ${embedTotal(embed)}/6000 characters in total.`;
  if (!httpsOk(embed.imageUrl)) problems.imageUrl = 'Image must be an https:// link.';
  if (!httpsOk(embed.thumbnailUrl)) problems.thumbnailUrl = 'Thumbnail must be an https:// link.';
  if (!httpsOk(embed.url)) problems.url = 'Link must be an https:// link.';
  if (!embed.title && !embed.description && !embed.fields.length && !embed.imageUrl) problems.empty = 'Add a title, description, field or image.';
  return problems;
}

/** Problems of a whole message body (text and/or embed). */
export function bodyProblems(body: MessageBodyDto, extraContentLength = 0): string[] {
  const out: string[] = [];
  if (!body.content?.trim() && !body.embed) out.push('Add text or an embed.');
  if (length(body.content) + extraContentLength > L.messageContentLength) out.push(`Text (with mentions) is longer than ${L.messageContentLength} characters.`);
  if (body.embed) out.push(...Object.values(embedProblems(body.embed)));
  return out;
}

/** Cleans a draft for the API: blank strings become null. */
export function normalizeBody(body: MessageBodyDto): MessageBodyDto {
  const blank = (value: string | null) => value && value.trim() ? value : null;
  return { content: blank(body.content), embed: body.embed ? { ...body.embed, title: blank(body.embed.title), description: blank(body.embed.description),
    url: blank(body.embed.url), imageUrl: blank(body.embed.imageUrl), thumbnailUrl: blank(body.embed.thumbnailUrl),
    footer: blank(body.embed.footer) } : null };
}

export const hexColor = (color: number | null) => color === null ? '' : `#${color.toString(16).padStart(6, '0')}`;
export function parseHexColor(value: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? parseInt(match[1]!, 16) : null;
}

export type MarkdownToken =
  | { kind: 'text'; text: string } | { kind: 'bold' | 'italic' | 'underline' | 'strike'; children: MarkdownToken[] }
  | { kind: 'code'; text: string } | { kind: 'link'; text: string; href: string } | { kind: 'break' };

const RULES: Array<{ re: RegExp; make(match: RegExpExecArray): MarkdownToken }> = [
  { re: /^`([^`\n]+)`/, make: m => ({ kind: 'code', text: m[1]! }) },
  { re: /^\*\*([\s\S]+?)\*\*/, make: m => ({ kind: 'bold', children: parseMarkdown(m[1]!) }) },
  { re: /^__([\s\S]+?)__/, make: m => ({ kind: 'underline', children: parseMarkdown(m[1]!) }) },
  { re: /^~~([\s\S]+?)~~/, make: m => ({ kind: 'strike', children: parseMarkdown(m[1]!) }) },
  { re: /^\*([^*\n]+?)\*/, make: m => ({ kind: 'italic', children: parseMarkdown(m[1]!) }) },
  { re: /^_([^_\n]+?)_/, make: m => ({ kind: 'italic', children: parseMarkdown(m[1]!) }) },
  { re: /^\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/, make: m => ({ kind: 'link', text: m[1]!, href: m[2]! }) }
];

/** Discord's common inline markdown (bold, italic, underline, strike, code, https links, line breaks). Never HTML. */
export function parseMarkdown(source: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let text = '';
  let rest = source;
  const flush = () => { if (text) { tokens.push({ kind: 'text', text }); text = ''; } };
  while (rest.length) {
    if (rest[0] === '\n') { flush(); tokens.push({ kind: 'break' }); rest = rest.slice(1); continue; }
    let matched = false;
    for (const rule of RULES) {
      const match = rule.re.exec(rest);
      if (match) { flush(); tokens.push(rule.make(match)); rest = rest.slice(match[0].length); matched = true; break; }
    }
    if (!matched) { text += rest[0]; rest = rest.slice(1); }
  }
  flush();
  return tokens;
}
