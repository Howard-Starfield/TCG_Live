import { fileURLToPath } from 'node:url';

export type VisualState = 'signup' | 'checkin' | 'setup' | 'running' | 'paused' | 'proposal' |
  'disputed' | 'expired' | 'final' | 'reminder' | 'notice' | 'error';

const files: Record<VisualState, string> = {
  signup: 'tcg-signup-v1.gif', checkin: 'tcg-checkin-v1.gif', setup: 'tcg-setup-v1.gif',
  running: 'tcg-running-v1.gif', paused: 'tcg-paused-v1.gif', proposal: 'tcg-proposal-v1.gif',
  disputed: 'tcg-disputed-v1.png', expired: 'tcg-expired-v1.png', final: 'tcg-final-v1.gif',
  reminder: 'tcg-reminder-v1.gif', notice: 'tcg-notice-v1.gif', error: 'tcg-error-v1.png'
};

export function visualFilename(state: VisualState): string { return files[state]; }

export function visualThumbnail(state: VisualState): { url: string } {
  return { url: `attachment://${visualFilename(state)}` };
}

export function visualFile(filename: string): { attachment: string; name: string } | null {
  if (!Object.values(files).includes(filename)) return null;
  return { attachment: fileURLToPath(new URL(`../../assets/discord/${filename}`, import.meta.url)), name: filename };
}

export function filenameFromThumbnail(thumbnail?: { url: string }): string | null {
  if (!thumbnail?.url.startsWith('attachment://')) return null;
  const filename = thumbnail.url.slice('attachment://'.length);
  return visualFile(filename) ? filename : null;
}

/** Discord can hide an embed-consumed upload from attachments; validate its owned CDN path. */
export function retainedVisual(message: {
  attachments?: { size: number; values(): IterableIterator<{ name: string | null }> };
  author?: { id: string };
  embeds?: readonly { thumbnail?: { url: string } | null }[];
}, channelId: string, botId: string, filename: string): boolean {
  if (!visualFile(filename)) return false;
  const attachments = message.attachments;
  if (attachments?.size === 1 && [...attachments.values()][0]?.name === filename) return true;
  if (attachments?.size !== 0 || message.author?.id !== botId) return false;
  try {
    const thumbnail = new URL(message.embeds?.[0]?.thumbnail?.url ?? '');
    const path = thumbnail.pathname.match(/^\/attachments\/([1-9]\d{14,21})\/([1-9]\d{14,21})\/([^/]+)$/);
    return thumbnail.protocol === 'https:' && !thumbnail.port && !thumbnail.username && !thumbnail.password &&
      !thumbnail.hash && ['cdn.discordapp.com', 'media.discordapp.net'].includes(thumbnail.hostname) &&
      path?.[1] === channelId && path[3] === filename;
  } catch { return false; }
}

export function noticeVisual(message: string): VisualState {
  if (/^Saved:|^Practice cards refreshed\./.test(message) && !/pending/i.test(message)) return 'final';
  if (/pending/i.test(message) || /^No change:/.test(message)) return 'notice';
  return 'error';
}

export function noticeEmbed(message: string): { description: string; color: number; thumbnail: { url: string } } {
  const state = noticeVisual(message);
  return { description: message, color: state === 'final' ? 0x22c55e : state === 'error' ? 0xef4444 : 0xf59e0b,
    thumbnail: visualThumbnail(state) };
}
