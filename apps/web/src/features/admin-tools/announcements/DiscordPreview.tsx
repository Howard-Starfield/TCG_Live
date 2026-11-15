// A live preview that resembles a Discord message: mention line, text, embed (colour bar, title, markdown
// description, fields in inline rows, image, thumbnail, footer) and optional button rows. Rendered as
// React elements only (no HTML injection); images load only from https links.
import type { ButtonStyleName, EmbedDto, GuildRoleDto } from '@tcg-live/core';
import { Fragment, type ReactNode } from 'react';
import { cx } from '../../../ui';
import { hexColor, parseMarkdown, type MarkdownToken } from './embed';

function Markdown({ source }: { source: string }) {
  const render = (tokens: MarkdownToken[]): ReactNode => tokens.map((token, index) => {
    switch (token.kind) {
      case 'text': return <Fragment key={index}>{token.text}</Fragment>;
      case 'break': return <br key={index} />;
      case 'bold': return <strong key={index}>{render(token.children)}</strong>;
      case 'italic': return <em key={index}>{render(token.children)}</em>;
      case 'underline': return <u key={index}>{render(token.children)}</u>;
      case 'strike': return <s key={index}>{render(token.children)}</s>;
      case 'code': return <code key={index} className="rounded bg-[#2b2d31] px-1 font-mono text-[0.85em]">{token.text}</code>;
      case 'link': return <a key={index} href={token.href} target="_blank" rel="noreferrer noopener" className="text-[#00a8fc] hover:underline">{token.text}</a>;
    }
  });
  return <>{render(parseMarkdown(source))}</>;
}

const https = (url: string | null) => url && /^https:\/\/\S+$/.test(url) ? url : null;
const BUTTON: Record<ButtonStyleName, string> = {
  primary: 'bg-[#5865f2]', secondary: 'bg-[#4e5058]', success: 'bg-[#248046]', danger: 'bg-[#da373c]'
};

export interface PreviewButton { label: string; emoji: string | null; style: ButtonStyleName }

export function DiscordPreview({ content, embed, mentionRoleIds = [], mentionEveryone = false, roles = [], buttons = [], label = 'Discord preview' }: {
  content: string | null; embed: EmbedDto | null; mentionRoleIds?: readonly string[]; mentionEveryone?: boolean;
  roles?: readonly GuildRoleDto[]; buttons?: readonly PreviewButton[]; label?: string;
}) {
  const roleName = (id: string) => roles.find(role => role.id === id)?.name ?? 'unknown-role';
  const mentions = [...(mentionEveryone ? ['@everyone'] : []), ...mentionRoleIds.map(id => `@${roleName(id)}`)];
  const inlineRows: EmbedDto['fields'][] = [];
  for (const field of embed?.fields ?? []) {
    const last = inlineRows[inlineRows.length - 1];
    if (field.inline && last && last.length < 3 && last.every(item => item.inline)) last.push(field);
    else inlineRows.push([field]);
  }
  return <figure aria-label={label} className="flex gap-3 rounded-lg bg-[#313338] p-3 text-[14px] leading-[1.375] text-[#dbdee1]">
    <div aria-hidden className="size-9 shrink-0 rounded-full bg-[#5865f2]" />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2"><span className="font-medium text-white">TCG Live</span>
        <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold text-white">APP</span>
        <span className="text-[11px] text-[#949ba4]">Today</span></div>
      {(mentions.length > 0 || content) && <p className="whitespace-pre-wrap break-words">
        {mentions.map(mention => <span key={mention} className="mr-1 rounded bg-[#5865f24d] px-0.5 text-[#c9cdfb]">{mention}</span>)}
        {content && <Markdown source={content} />}
      </p>}
      {embed && <div data-testid="embed" className="mt-1 grid max-w-[520px] rounded border-l-4 bg-[#2b2d31] p-3"
        style={{ borderLeftColor: embed.color === null ? '#1e1f22' : hexColor(embed.color) }}>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            {embed.title && <p className="mb-1 font-semibold text-white">{https(embed.url)
              ? <a href={https(embed.url)!} target="_blank" rel="noreferrer noopener" className="text-[#00a8fc]">{embed.title}</a> : embed.title}</p>}
            {embed.description && <div className="whitespace-pre-wrap break-words text-[13px]"><Markdown source={embed.description} /></div>}
            {inlineRows.map((row, rowIndex) => <div key={rowIndex} className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
              {row.map((field, index) => <div key={index} className="min-w-0 text-[13px]">
                <p className="font-semibold text-white">{field.name}</p>
                <div className="whitespace-pre-wrap break-words"><Markdown source={field.value} /></div>
              </div>)}
            </div>)}
          </div>
          {https(embed.thumbnailUrl) && <img src={https(embed.thumbnailUrl)!} alt="Thumbnail" className="size-20 shrink-0 rounded object-cover" />}
        </div>
        {https(embed.imageUrl) && <img src={https(embed.imageUrl)!} alt="Embed image" className="mt-3 max-h-72 rounded object-contain" />}
        {embed.footer && <p className="mt-2 text-[11px] text-[#b5bac1]">{embed.footer}</p>}
      </div>}
      {buttons.length > 0 && <div className="mt-2 flex flex-col gap-1.5">
        {Array.from({ length: Math.ceil(buttons.length / 5) }, (_, row) => <div key={row} className="flex flex-wrap gap-1.5">
          {buttons.slice(row * 5, row * 5 + 5).map((button, index) => <span key={index}
            className={cx('inline-flex h-8 items-center gap-1 rounded px-3 text-[13px] font-medium text-white', BUTTON[button.style])}>
            {button.emoji && <span aria-hidden>{/^\d+$/.test(button.emoji) ? ':emoji:' : button.emoji}</span>}{button.label || 'Button'}
          </span>)}
        </div>)}
      </div>}
    </div>
  </figure>;
}
