// Evidence playback. <video>/<audio> cannot send an Authorization header, so the player asks for a
// short-lived playback ticket and uses its URL as `src`. Before the ticket expires, or when playback
// fails (an expired or revoked ticket answers 401/403/404, which the element reports only as an error),
// it fetches a new ticket and resumes at the same position. A file the browser cannot decode (an
// unsupported codec) switches to the download-only view at once instead of re-requesting tickets.
import { EVIDENCE_DOWNLOAD_ONLY_MIME, type EvidenceItemDto, type PlaybackTicketDto } from '@tcg-live/core';
import { Download, ExternalLink, Pause, Play, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { useAdminData, useServerClock } from '../../data';
import { Button, Switch, cx } from '../../ui';
import { describeError, downloadUrl, formatDuration, requestPlayback } from './api';

/** Refresh this long before the ticket expires. */
export const TICKET_REFRESH_MARGIN_MS = 60_000;
/** Consecutive media errors that each fetch a new ticket before the player gives up. */
const MAX_TICKET_RETRIES = 2;
/** After one ticket that is already near expiry, later short tickets wait at least this long (no refresh loop on skew or a short TTL). */
export const MIN_TICKET_REFRESH_DELAY_MS = 10_000;

/** Stops a media element from buffering further after it leaves the page (detached elements keep downloading). */
export function releaseMedia(element: HTMLMediaElement | null): void {
  if (!element) return;
  try {
    element.pause();
    element.removeAttribute('src');
    element.load();
  } catch { /* Not implemented in some environments. */ }
}

/**
 * A stable callback ref that tracks the element in `ref` and releases it only when React detaches it
 * (unmount or a different element). It must be stable: an inline callback ref is detached (called with
 * null) and re-attached on every render, which would strip `src` that React then never sets again
 * because the prop did not change.
 */
function useMediaRef(ref: RefObject<HTMLMediaElement | null>) {
  return useCallback((element: HTMLMediaElement | null) => {
    if (!element) releaseMedia(ref.current);
    ref.current = element;
  }, [ref]);
}

export interface PlayerMarker {
  id: string | number;
  /** Offset into the recording. */
  offsetMs: number;
  label: string;
}

export interface EvidencePlayerHandle {
  seek(offsetMs: number): void;
}

const isAudio = (item: EvidenceItemDto) => item.kind === 'voice' || (item.mime?.startsWith('audio/') ?? false);

interface TicketedSource {
  src: string | null;
  ticket: PlaybackTicketDto | null;
  error: string | null;
  loading: boolean;
  /** The browser cannot decode this file (for example HEVC or ProRes): show the download-only view. */
  unsupported: boolean;
  handlers: {
    onLoadedMetadata(): void;
    onError(): void;
    onPlaying(): void;
    onPause(): void;
    onSeeking(): void;
  };
}

/** HTMLMediaElement error codes (MediaError.MEDIA_ERR_*). */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * True when the ticket URL itself still answers, so a "source not supported" error means the codec and
 * not an expired or revoked ticket (the element reports both with the same code). HEAD is not audited.
 */
export async function ticketStillServes(url: string): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    return response.ok;
  } catch { return false; }
}

/**
 * A playback ticket for `itemId` kept fresh, plus the media handlers that resume after a swap.
 *
 * Refreshing does not interrupt playback: the next ticket is fetched TICKET_REFRESH_MARGIN_MS early and
 * kept as a spare. It replaces `src` at once only when nothing is playing; otherwise at the next pause
 * or seek (which rebuffer anyway), or when the old ticket fails. A progressive download already under
 * way keeps streaming on the old ticket, because the server checks a ticket only when a request starts.
 */
function useTicketedSource(itemId: string, media: RefObject<HTMLMediaElement | null>, enabled: boolean): TicketedSource {
  const { api } = useAdminData();
  const clock = useServerClock();
  const [ticket, setTicket] = useState<PlaybackTicketDto | null>(null);
  const [spare, setSpare] = useState<PlaybackTicketDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  const failures = useRef(0);
  const live = useRef(true);
  const inFlight = useRef(false);
  /** Consecutive tickets that arrived already inside the refresh margin. */
  const shortTickets = useRef(0);

  const rememberPosition = useCallback(() => {
    const element = media.current;
    if (element && element.currentSrc) resume.current = { time: element.currentTime, playing: !element.paused && !element.ended };
  }, [media]);

  const fetchTicket = useCallback(async (): Promise<PlaybackTicketDto | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await requestPlayback(api, itemId);
      if (!live.current) return null;
      setError(null);
      return next;
    } catch (cause) {
      if (live.current) setError(describeError(cause, 'Playback could not start.'));
      return null;
    } finally {
      inFlight.current = false;
      if (live.current) setLoading(false);
    }
  }, [api, itemId]);

  const swapIn = useCallback((next: PlaybackTicketDto) => {
    rememberPosition();
    setSpare(null);
    setTicket(next);
  }, [rememberPosition]);

  /** Replaces the source now (first load, or the current ticket failed), resuming at the same position. */
  const refresh = useCallback(async (keepPosition: boolean) => {
    if (keepPosition) rememberPosition();
    const next = await fetchTicket();
    if (next) { setSpare(null); setTicket(next); }
  }, [fetchTicket, rememberPosition]);

  /** Fetches the next ticket early and swaps it in only while nothing is playing. */
  const prefetch = useCallback(async () => {
    const next = await fetchTicket();
    if (!next) return;
    const element = media.current;
    if (!element || element.paused || element.ended || !element.currentSrc) swapIn(next);
    else setSpare(next);
  }, [fetchTicket, media, swapIn]);

  useEffect(() => {
    live.current = true;
    failures.current = 0;
    resume.current = null;
    setTicket(null);
    setSpare(null);
    setError(null);
    setUnsupported(false);
    if (enabled) void refresh(false);
    return () => { live.current = false; };
  }, [enabled, refresh]);

  // The newest ticket held (the spare, while one waits) decides when to fetch the next.
  const latest = spare ?? ticket;
  useEffect(() => {
    if (!latest || unsupported) return;
    const due = latest.expiresAtMs - clock.now() - TICKET_REFRESH_MARGIN_MS;
    shortTickets.current = due < MIN_TICKET_REFRESH_DELAY_MS ? shortTickets.current + 1 : 0;
    const delay = shortTickets.current > 1 ? MIN_TICKET_REFRESH_DELAY_MS : Math.max(0, due);
    const timer = setTimeout(() => { void prefetch(); }, delay);
    return () => clearTimeout(timer);
  }, [clock, latest, prefetch, unsupported]);

  const giveUp = () => setError('This recording could not be played. Try downloading it instead.');
  const handlers = {
    onLoadedMetadata: () => {
      const element = media.current;
      const pending = resume.current;
      if (!element || !pending) return;
      resume.current = null;
      element.currentTime = pending.time;
      if (pending.playing) void element.play()?.catch(() => {});
    },
    onError: () => {
      if (!ticket || unsupported) return;
      // A spare is ready: the old ticket most likely expired mid-stream. Swap without counting a failure.
      if (spare) { swapIn(spare); return; }
      const code = media.current?.error?.code;
      // The data arrived but cannot be decoded: retrying with new tickets cannot help.
      if (code === MEDIA_ERR_DECODE) { setUnsupported(true); return; }
      if (code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
        void ticketStillServes(ticket.url).then(serves => {
          if (!live.current) return;
          if (serves) { setUnsupported(true); return; }
          if (failures.current >= MAX_TICKET_RETRIES) { giveUp(); return; }
          failures.current += 1;
          void refresh(true);
        });
        return;
      }
      // Network errors and expired or revoked tickets: a fresh ticket, a bounded number of times.
      if (failures.current >= MAX_TICKET_RETRIES) { giveUp(); return; }
      failures.current += 1;
      void refresh(true);
    },
    onPlaying: () => { failures.current = 0; },
    onPause: () => { if (spare) swapIn(spare); },
    onSeeking: () => { if (spare) swapIn(spare); }
  };
  return { src: ticket?.url ?? null, ticket, error, loading, unsupported, handlers };
}

function DownloadButton({ item, label = 'Download' }: { item: EvidenceItemDto; label?: string }) {
  const { api } = useAdminData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true); setError(null);
    try {
      const ticket = await requestPlayback(api, item.id);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl(ticket.url);
      anchor.rel = 'noopener noreferrer';
      if (item.originalName) anchor.download = item.originalName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      setError(describeError(cause, 'The download could not start.'));
    } finally { setBusy(false); }
  };
  return <span className="inline-flex flex-col gap-1">
    <Button size="sm" variant="secondary" icon={<Download aria-hidden />} loading={busy} onClick={() => void download()}
      aria-label={`${label} ${item.originalName ?? 'evidence'}`}>{label}</Button>
    {error && <span role="alert" className="text-2xs text-danger">{error}</span>}
  </span>;
}
export { DownloadButton as EvidenceDownloadButton };

/** Text longer than this starts clamped, with a Show more button. */
const NOTE_CLAMP_CHARS = 280;

/** Text-only evidence (kind 'note'): the written account, clamped when long and expandable. No player, no download. */
export function NoteEvidence({ item }: { item: EvidenceItemDto }) {
  const [expanded, setExpanded] = useState(false);
  const long = item.note.length > NOTE_CLAMP_CHARS || item.note.split('\n').length > 6;
  return <div className="flex flex-col items-start gap-1.5 rounded-lg bg-sunken p-3" data-testid="evidence-note">
    <p className={cx('w-full whitespace-pre-wrap break-words text-xs text-fg', long && !expanded && 'line-clamp-6')}>{item.note}</p>
    {long && <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(open => !open)}>
      {expanded ? 'Show less' : 'Show more'}
    </Button>}
  </div>;
}

/** External link evidence: never embedded; opens in a new tab after a clear warning. */
function LinkEvidence({ item }: { item: EvidenceItemDto }) {
  const url = item.externalUrl ?? '';
  let host = url;
  try { host = new URL(url).host; } catch { /* Shown as given. */ }
  return <div className="flex flex-col gap-2 rounded-lg bg-sunken p-3" data-testid="evidence-link">
    <p className="flex items-start gap-2 text-xs text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>External link to <b className="font-semibold">{host}</b>. It opens a site outside TCG Live in a new tab; only open links you trust.</span>
    </p>
    <p className="break-all font-mono text-2xs text-fg-muted">{url}</p>
    <span>
      <a href={url} target="_blank" rel="noopener noreferrer"
        className="ui-press inline-flex h-7 items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-line-faint [&_svg]:size-3.5">
        <ExternalLink aria-hidden />Open link in new tab
      </a>
    </span>
  </div>;
}

function Markers({ markers, durationMs, onSeek }: { markers: PlayerMarker[]; durationMs: number | null; onSeek(offsetMs: number): void }) {
  if (markers.length === 0) return null;
  return <div className="flex flex-col gap-1">
    {durationMs && durationMs > 0 && <div aria-hidden className="relative h-1.5 rounded-full bg-line-faint">
      {markers.map(marker => <span key={marker.id} className="absolute top-0 h-1.5 w-1 rounded-full bg-warning"
        style={{ left: `${Math.min(100, (marker.offsetMs / durationMs) * 100)}%` }} />)}
    </div>}
    <ul aria-label="Volume flags in this recording" className="flex flex-wrap gap-1">
      {markers.map(marker => <li key={marker.id}>
        <button type="button" onClick={() => onSeek(marker.offsetMs)}
          className="ui-press inline-flex h-6 items-center gap-1 rounded-full bg-warning-soft px-2 text-2xs font-medium text-warning hover:brightness-95">
          {formatDuration(marker.offsetMs)} · {marker.label}
        </button>
      </li>)}
    </ul>
  </div>;
}

export interface EvidencePlayerProps {
  item: EvidenceItemDto;
  markers?: PlayerMarker[];
  ref?: Ref<EvidencePlayerHandle>;
}

/** Plays one evidence item: inline media, a download-only notice, or an external-link card. */
export function EvidencePlayer({ item, markers = [], ref }: EvidencePlayerProps) {
  const media = useRef<HTMLMediaElement | null>(null);
  const playable = item.kind !== 'link' && item.kind !== 'note' && item.status === 'stored' && item.playable;
  const source = useTicketedSource(item.id, media, playable);
  const attachMedia = useMediaRef(media);
  const seek = useCallback((offsetMs: number) => {
    const element = media.current;
    if (!element) return;
    element.currentTime = offsetMs / 1000;
    void element.play()?.catch(() => {});
  }, []);
  useImperativeHandle(ref, () => ({ seek }), [seek]);

  if (item.kind === 'link') return <LinkEvidence item={item} />;
  // A deleted note falls through to the generic "Deleted" message: its text is not shown again.
  if (item.kind === 'note' && item.status === 'stored') return <NoteEvidence item={item} />;
  if (item.status !== 'stored') {
    return <p className="rounded-lg bg-sunken p-3 text-xs text-fg-muted" data-testid="evidence-unavailable">
      {item.status === 'pending' ? 'This file is still being stored. Check again in a moment.'
        : item.status === 'failed' ? 'This file could not be stored.' : `Deleted${item.deleteReason ? `: ${item.deleteReason}` : '.'}`}
    </p>;
  }
  if (!item.playable || source.unsupported) {
    // A container browsers cannot play (MKV), a codec flagged at upload (HEVC or ProRes, stored with
    // EVIDENCE_DOWNLOAD_ONLY_MIME), or a file this browser just failed to decode.
    const codec = source.unsupported || item.mime === EVIDENCE_DOWNLOAD_ONLY_MIME;
    return <div className="flex flex-col items-start gap-2 rounded-lg bg-sunken p-3" data-testid="evidence-download-only">
      <p className="text-xs text-fg-muted">{codec
        ? 'This video uses a format your browser cannot play (for example HEVC or ProRes). Download it to watch it in a desktop player such as VLC.'
        : `This file type${item.mime ? ` (${item.mime})` : ''} cannot play in the browser. Download it to watch it in a desktop player.`}</p>
      <DownloadButton item={item} />
    </div>;
  }
  const Media = isAudio(item) ? 'audio' : 'video';
  return <div className="flex flex-col gap-2">
    {source.src ? <Media ref={attachMedia} src={source.src} controls preload="metadata"
      data-testid="evidence-media" aria-label={`Evidence ${item.originalName ?? item.kind}`}
      className={cx('w-full rounded-lg bg-black', Media === 'video' ? 'max-h-[50vh]' : 'h-10 bg-transparent')}
      {...source.handlers} />
      : !source.error && <p role="status" className="text-xs text-fg-muted">Preparing playback…</p>}
    {source.error && <p role="alert" className="text-xs text-danger">{source.error}</p>}
    <Markers markers={markers} durationMs={item.durationMs} onSeek={seek} />
  </div>;
}

/** Two players' recordings of the same match, played, paused and seeked together. */
export function SyncedVoicePlayer({ tracks, labels, markers = [] }: {
  tracks: [EvidenceItemDto, EvidenceItemDto]; labels: [string, string]; markers?: PlayerMarker[];
}) {
  const first = useRef<HTMLMediaElement | null>(null);
  const second = useRef<HTMLMediaElement | null>(null);
  const a = useTicketedSource(tracks[0].id, first, true);
  const b = useTicketedSource(tracks[1].id, second, true);
  const attachFirst = useMediaRef(first);
  const attachSecond = useMediaRef(second);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState<[boolean, boolean]>([false, false]);
  const durationMs = Math.max(tracks[0].durationMs ?? 0, tracks[1].durationMs ?? 0) || null;
  const elements = () => [first.current, second.current].filter((element): element is HTMLMediaElement => element !== null);
  // The longer track leads: its clock drives the slider and its end stops both.
  const leadIndex = (tracks[1].durationMs ?? 0) > (tracks[0].durationMs ?? 0) ? 1 : 0;
  const leadRef = leadIndex === 0 ? first : second;
  const followRef = leadIndex === 0 ? second : first;

  const seek = (seconds: number) => {
    for (const element of elements()) element.currentTime = Math.min(seconds, Number.isFinite(element.duration) ? element.duration : seconds);
    setTime(seconds);
  };
  const toggle = () => {
    if (playing) { for (const element of elements()) element.pause(); setPlaying(false); return; }
    const lead = leadRef.current?.currentTime ?? 0;
    for (const element of elements()) {
      element.currentTime = Math.min(lead, Number.isFinite(element.duration) ? element.duration : lead);
      void element.play()?.catch(() => {});
    }
    setPlaying(true);
  };
  const onLeadTime = () => {
    const lead = leadRef.current;
    const follower = followRef.current;
    if (!lead) return;
    setTime(lead.currentTime);
    // Keep the second track within 300 ms of the first.
    if (follower && !follower.paused && !follower.ended && !lead.paused
      && Math.abs(follower.currentTime - lead.currentTime) > 0.3) follower.currentTime = lead.currentTime;
  };
  const sources = [a, b] as const;
  const attachers = [attachFirst, attachSecond] as const;
  const error = a.error ?? b.error;
  return <div className="flex flex-col gap-2" data-testid="synced-voice-player">
    <div className="flex items-center gap-2">
      <Button size="sm" variant="primary" icon={playing ? <Pause aria-hidden /> : <Play aria-hidden />} onClick={toggle}
        disabled={!a.src || !b.src}>{playing ? 'Pause both' : 'Play both'}</Button>
      <input type="range" aria-label="Seek both recordings" min={0} max={(durationMs ?? 0) / 1000 || 1} step={0.1} value={time}
        onChange={event => seek(Number(event.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
      <span className="font-mono text-2xs tabular-nums text-fg-muted">{formatDuration(time * 1000)} / {formatDuration(durationMs)}</span>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      {tracks.map((track, index) => {
        const source = sources[index]!;
        const attach = attachers[index]!;
        return <div key={track.id} className="flex items-center justify-between gap-2 rounded-md bg-sunken px-2.5 py-1.5">
          <span className="min-w-0 truncate text-xs text-fg">{labels[index]}</span>
          {source.src && <audio ref={attach} src={source.src} preload="metadata"
            muted={muted[index]} aria-label={`Recording of ${labels[index]}`} {...source.handlers}
            onTimeUpdate={index === leadIndex ? onLeadTime : undefined}
            onEnded={index === leadIndex ? () => { for (const element of elements()) element.pause(); setPlaying(false); } : undefined} />}
          <Switch size="sm" aria-label={`Hear ${labels[index]}`} checked={!muted[index]}
            onCheckedChange={on => setMuted(current => (index === 0 ? [!on, current[1]] : [current[0], !on]))} />
        </div>;
      })}
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <Markers markers={markers} durationMs={durationMs} onSeek={offsetMs => { seek(offsetMs / 1000); if (!playing) toggle(); }} />
  </div>;
}
