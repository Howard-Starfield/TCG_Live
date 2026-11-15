// Evidence drawer for one match: the evidence list (oldest first), a player for the selected item, and
// the admin actions (add, hold, delete with a reason, download). Volume flags for the match appear as
// markers that seek the recording to the moment of the spike.
import { EVIDENCE_NOTE_MAX_LENGTH, type EventSnapshotDto, type EvidenceItemDto, type MatchId,
  type ModerationFlagDto } from '@tcg-live/core';
import { FileVideo, Link2, Lock, LockOpen, Mic, Paperclip, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTimeOfDay, memberName, useAdminData } from '../../data';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, SegmentedControl, Textarea, cx, useEscapeLayer,
  type Tone } from '../../ui';
import { useMatchVolumeFlags } from '../moderation/api';
import { seatName } from '../shell/labels';
import { addEvidenceLink, deleteEvidence, describeError, describeUploadError, formatBytes, formatDuration, isNotAvailable, setEvidenceHold,
  uploadEvidence, uploadRate, useEvidenceAccess, useEvidenceCacheUpdate, useEvidenceList, validateDeleteReason, validateEvidenceFile,
  validateEvidenceUrl, validateNote } from './api';
import { EvidenceCaseTools } from '../admin-tools/members/EvidenceCaseTools';
import { EvidenceDownloadButton, EvidencePlayer, SyncedVoicePlayer, type PlayerMarker } from './EvidencePlayer';

const KIND_TONE: Record<EvidenceItemDto['kind'], Tone> = { upload: 'accent', link: 'neutral', voice: 'warning' };
const KIND_ICON = { upload: FileVideo, link: Link2, voice: Mic } as const;
/** Two voice files of the same match whose recordings started this close together play side by side. */
const PAIR_WINDOW_MS = 60_000;

export function submitterLabel(snapshot: EventSnapshotDto, item: EvidenceItemDto): string {
  if (item.seat) return `${seatName(snapshot, item.seat)} (Seat ${item.seat})`;
  if (item.submittedBy === 'local-admin') return 'Admin (dashboard)';
  if (item.submittedBy === 'bot') {
    const player = voicePlayerId(item);
    return player ? `${memberName(snapshot, player)} (bot recording)` : 'Bot recorder';
  }
  return memberName(snapshot, item.submittedBy);
}

/** Evidence sorted by time, oldest first, ties by ID so the order is stable. */
export function sortEvidence(items: readonly EvidenceItemDto[]): EvidenceItemDto[] {
  return [...items].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

/**
 * The Discord user a bot voice recording belongs to: `recordedUserId`, else (older rows) parsed from the
 * recorder's file name `<match>-voice-<userId>.ogg`.
 */
export function voicePlayerId(item: EvidenceItemDto): string | null {
  if (item.kind !== 'voice') return null;
  if (item.recordedUserId) return item.recordedUserId;
  return /-voice-(\d{15,22})\.ogg$/.exec(item.originalName ?? '')?.[1] ?? null;
}

/** True when two voice tracks are clearly different players: seats when both have one, else the recorded user or file name. */
function differentPlayers(a: EvidenceItemDto, b: EvidenceItemDto): boolean {
  if (a.seat !== null && b.seat !== null) return a.seat !== b.seat;
  const userA = voicePlayerId(a);
  const userB = voicePlayerId(b);
  if (userA !== null && userB !== null) return userA !== userB;
  return a.originalName !== null && b.originalName !== null && a.originalName !== b.originalName;
}

/** The other player's voice track recorded alongside `item` (closest start within the window), if there is one. */
export function voicePartner(items: readonly EvidenceItemDto[], item: EvidenceItemDto): EvidenceItemDto | null {
  if (item.kind !== 'voice' || item.status !== 'stored' || !item.playable) return null;
  const candidates = items.filter(other => other.id !== item.id && other.kind === 'voice' && other.status === 'stored' && other.playable
    && other.matchId === item.matchId && differentPlayers(item, other)
    && Math.abs(recordingStart(other) - recordingStart(item)) <= PAIR_WINDOW_MS);
  const start = recordingStart(item);
  candidates.sort((x, y) => Math.abs(recordingStart(x) - start) - Math.abs(recordingStart(y) - start));
  return candidates[0] ?? null;
}

/** When the recording began: `recordingStartedAtMs`, else (older rows) the row's createdAtMs. */
export function recordingStart(item: EvidenceItemDto): number {
  return item.recordingStartedAtMs ?? item.createdAtMs;
}

/** How far a flag's recording start may sit from the recording start (the createdAtMs fallback lags the recorder). */
const RECORDING_START_TOLERANCE_MS = 10_000;

/**
 * Flag markers inside a recording that started at `startMs` and lasts `durationMs`. A volume flag's
 * `recordingOffsetMs` (written by the recorder) is the offset when present; otherwise it is derived from timestamps.
 */
export function flagMarkers(flags: readonly ModerationFlagDto[], startMs: number, durationMs: number | null,
  snapshot: EventSnapshotDto): PlayerMarker[] {
  if (!durationMs) return [];
  return flags.flatMap(flag => {
    const recorded = flag.kind === 'volume' && typeof flag.detail.recordingOffsetMs === 'number' ? flag.detail.recordingOffsetMs : null;
    let offsetMs: number;
    if (recorded !== null) {
      // Only this recording's flags: the recording the flag points into must have started when this one did.
      if (Math.abs(flag.occurredAtMs - recorded - startMs) > RECORDING_START_TOLERANCE_MS) return [];
      offsetMs = recorded;
    } else {
      offsetMs = flag.occurredAtMs - startMs;
    }
    if (offsetMs < 0 || offsetMs > durationMs) return [];
    const who = flag.userId ? memberName(snapshot, flag.userId) : 'someone';
    const label = flag.kind === 'volume' ? `loud: ${who} (${Math.round(flag.detail.peakDbfs)} dBFS)` : `keyword: ${who}`;
    return [{ id: flag.id, offsetMs, label }];
  });
}

function EvidenceRow({ snapshot, item, selected, onSelect }: {
  snapshot: EventSnapshotDto; item: EvidenceItemDto; selected: boolean; onSelect(): void;
}) {
  const Icon = KIND_ICON[item.kind];
  const deleted = item.status === 'deleted';
  const facts = [formatBytes(item.byteSize), formatDuration(item.durationMs)].filter(Boolean).join(' · ');
  return <button type="button" onClick={onSelect} aria-pressed={selected} data-evidence={item.id}
    className={cx('ui-press flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left',
      selected ? 'bg-accent-soft' : 'hover:bg-line-faint', deleted && 'opacity-60')}>
    <span className="flex w-full flex-wrap items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 text-fg-subtle" />
      <span className="min-w-0 truncate text-xs font-medium text-fg">{submitterLabel(snapshot, item)}</span>
      <Badge tone={KIND_TONE[item.kind]}>{item.kind}</Badge>
      {item.hold && <Badge tone="warning"><Lock aria-hidden className="size-2.5" />hold</Badge>}
      {item.status !== 'stored' && <Badge tone={item.status === 'failed' ? 'danger' : 'neutral'}>{item.status}</Badge>}
      {item.proposalRevision !== null && <Badge mono title="Dispute proposal revision">rev {item.proposalRevision}</Badge>}
      <time dateTime={new Date(item.createdAtMs).toISOString()} className="ml-auto font-mono text-2xs text-fg-subtle">
        {formatTimeOfDay(item.createdAtMs)}
      </time>
    </span>
    {item.note && <span className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-fg-muted">{item.note}</span>}
    {(facts || item.originalName) && <span className="truncate text-2xs text-fg-subtle">
      {[item.originalName, facts].filter(Boolean).join(' · ')}
    </span>}
  </button>;
}

type AddMode = 'file' | 'link';

function AddEvidence({ eventId, matchId, onAdded, onBusyChange }: {
  eventId: string; matchId: MatchId; onAdded(item: EvidenceItemDto): void;
  /** Reports an upload in flight so the drawer can block dismissal (closing it would abort the upload). */
  onBusyChange?(busy: boolean): void;
}) {
  const { api } = useAdminData();
  const [mode, setMode] = useState<AddMode>('file');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Recent progress samples (the last ~10 s) for the speed and time-left estimate. */
  const samples = useRef<{ atMs: number; loaded: number }[]>([]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  // An unmount mid-upload aborts it: never leave the drawer stuck undismissible.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  // Closing or reloading the tab mid-upload would throw the upload away: ask the browser to confirm.
  const uploading = busy && mode === 'file';
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const urlError = mode === 'link' ? validateEvidenceUrl(url) : null;
  const fileError = mode === 'file' ? (file ? validateEvidenceFile(file) : 'Choose a file.') : null;
  const noteError = validateNote(note);
  const invalid = Boolean(urlError || fileError || noteError);

  const submit = async () => {
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const controller = new AbortController();
    abort.current = controller;
    samples.current = [];
    try {
      if (mode === 'link') {
        onAdded(await addEvidenceLink(api, eventId, matchId, url.trim(), note.trim()));
      } else {
        const result = await uploadEvidence(api, eventId, matchId, file!, note.trim(), {
          signal: controller.signal, onProgress: (loaded, total) => {
            const now = Date.now();
            samples.current = [...samples.current.filter(sample => now - sample.atMs <= 10_000), { atMs: now, loaded }];
            setProgress({ loaded, total });
          }
        });
        onAdded(result.item);
        if (result.duplicate) setNotice('This file was already uploaded for this match, so it was not stored again. The earlier copy is selected.');
      }
      setUrl(''); setNote(''); setFile(null); setTouched(false); setProgress(null);
      if (input.current) input.current.value = '';
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(mode === 'file' ? describeUploadError(cause) : describeError(cause, 'The evidence could not be added.'));
      setProgress(null);
    } finally { setBusy(false); abort.current = null; }
  };
  const percent = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null;
  const rate = progress ? uploadRate(samples.current, progress.total) : null;

  return <form aria-label="Add evidence" className="flex flex-col gap-3 rounded-lg bg-raised p-3 shadow-[inset_0_0_0_1px_var(--color-line)]"
    onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold text-fg">Add evidence</h3>
      <SegmentedControl<AddMode> label="Evidence type" value={mode} onChange={next => { setMode(next); setTouched(false); setError(null); }}
        options={[{ value: 'file', label: 'Upload file' }, { value: 'link', label: 'Paste link' }]} />
    </div>
    {mode === 'file' ? <Field label="File" description="MP4, MOV, WebM, Ogg, MP3 or M4A play in the browser; MKV is download only."
      error={touched ? fileError : undefined}>
      <div className="flex items-center gap-2">
        <input ref={input} type="file" className="sr-only" aria-label="Choose evidence file"
          accept="video/mp4,video/quicktime,video/webm,audio/ogg,audio/mpeg,audio/mp4,video/x-matroska,.mkv,.m4a,.mov"
          onChange={event => { setFile(event.target.files?.[0] ?? null); setTouched(true); }} />
        <Button size="sm" icon={<Paperclip aria-hidden />} disabled={busy} onClick={() => input.current?.click()}>Choose file</Button>
        <span className="min-w-0 truncate text-xs text-fg-muted">{file ? `${file.name} · ${formatBytes(file.size)}` : 'No file chosen'}</span>
      </div>
    </Field> : <Field label="Link" description="An https link to YouTube, Twitch, Streamable, Medal, Drive or similar."
      error={touched ? urlError : undefined}>
      <Input type="url" value={url} placeholder="https://" disabled={busy} onChange={event => setUrl(event.target.value)}
        onBlur={() => setTouched(true)} />
    </Field>}
    <Field label="Note" description={`Optional, up to ${EVIDENCE_NOTE_MAX_LENGTH} characters.`} error={noteError}>
      <Textarea rows={2} value={note} disabled={busy} onChange={event => setNote(event.target.value)} />
    </Field>
    {progress && <div className="flex items-center gap-2">
      <progress aria-label="Upload progress" max={progress.total || 1} value={progress.loaded} className="h-1.5 flex-1 accent-[var(--color-accent)]" />
      <span className="font-mono text-2xs tabular-nums text-fg-muted">{percent === null ? formatBytes(progress.loaded) : `${percent}%`}</span>
      {rate && <span data-testid="upload-rate" className="font-mono text-2xs tabular-nums text-fg-muted">
        {formatBytes(Math.round(rate.bytesPerSecond))}/s{rate.etaMs !== null ? ` · ${formatDuration(rate.etaMs)} left` : ''}
      </span>}
      <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>Cancel</Button>
    </div>}
    {progress && <p className="text-2xs text-fg-muted">Keep this tab open until the upload finishes.</p>}
    {notice && <p role="status" className="text-xs text-fg-muted">{notice}</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <div className="flex justify-end">
      <Button type="submit" size="sm" variant="primary" loading={busy} icon={mode === 'file' ? <Upload aria-hidden /> : <Link2 aria-hidden />}>
        {mode === 'file' ? 'Upload' : 'Add link'}
      </Button>
    </div>
  </form>;
}

export interface EvidenceDrawerProps {
  open: boolean;
  onClose(): void;
  snapshot: EventSnapshotDto;
  matchId: MatchId;
}

export function EvidenceDrawer({ open, onClose, snapshot: liveSnapshot, matchId: liveMatchId }: EvidenceDrawerProps) {
  const { api } = useAdminData();
  // Pin the event and match the drawer was opened for: when the active event changes underneath (a new
  // tournament starts), keep showing the original match's evidence with the last snapshot of its event.
  const [pin, setPin] = useState<{ snapshot: EventSnapshotDto; matchId: MatchId } | null>(
    open ? { snapshot: liveSnapshot, matchId: liveMatchId } : null);
  if (open && (!pin || (pin.snapshot !== liveSnapshot && pin.snapshot.eventId === liveSnapshot.eventId))) {
    setPin({ snapshot: liveSnapshot, matchId: pin?.matchId ?? liveMatchId });
  } else if (!open && pin) {
    setPin(null);
  }
  const snapshot = pin?.snapshot ?? liveSnapshot;
  const matchId = pin?.matchId ?? liveMatchId;
  const earlierEvent = snapshot.eventId !== liveSnapshot.eventId;
  const access = useEvidenceAccess();
  const list = useEvidenceList(snapshot.eventId, matchId, open);
  const flags = useMatchVolumeFlags(snapshot.eventId, matchId, open);
  const update = useEvidenceCacheUpdate(snapshot.eventId, matchId);
  const items = useMemo(() => sortEvidence(list.data?.items ?? []), [list.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [deleting, setDeleting] = useState<EvidenceItemDto | null>(null);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const match = snapshot.matches.find(entry => entry.id === matchId);
  // Like the command dialogs: Escape closes the drawer wherever focus is (a control disabled during an
  // upload drops focus to <body>, outside the Dialog's own key handler). Swallowed mid-upload; the delete
  // confirmation, while open, handles its own Escape.
  useEscapeLayer(open && deleting === null, () => { if (!uploading) onClose(); });

  useEffect(() => { if (!open) { setSelectedId(null); setActionError(null); } }, [open]);
  const selected = items.find(item => item.id === selectedId)
    ?? items.find(item => item.kind !== 'link' && item.status === 'stored') ?? items[0] ?? null;
  const partner = selected ? voicePartner(items, selected) : null;
  const pair = selected && partner ? [selected, partner].sort((a, b) => (a.seat ?? '').localeCompare(b.seat ?? '')
    || (voicePlayerId(a) ?? '').localeCompare(voicePlayerId(b) ?? '')) as [EvidenceItemDto, EvidenceItemDto] : null;
  const volumeFlags = flags.data ?? [];

  const run = async (work: () => Promise<EvidenceItemDto>) => {
    setPending(true); setActionError(null);
    try { update(await work()); return true; } catch (cause) {
      setActionError(describeError(cause, 'The change could not be saved.'));
      return false;
    } finally { setPending(false); }
  };

  const title = `${matchId} evidence`;
  const players = match ? `${seatName(snapshot, match.seats[0])} vs ${seatName(snapshot, match.seats[1])}` : undefined;
  const description = earlierEvent
    ? [players, `From an earlier event (${snapshot.eventId})`].filter(Boolean).join(' · ')
    : players;

  let body;
  if (!access.read) {
    body = <EmptyState compact title="Evidence is not available" description="This session cannot view evidence." />;
  } else if (list.isLoading) {
    body = <p role="status" className="text-xs text-fg-muted">Loading evidence…</p>;
  } else if (list.error && !list.data) {
    body = <p role="alert" className="text-xs text-danger">{isNotAvailable(list.error)
      ? 'Evidence is not available in this version yet.' : describeError(list.error, 'Evidence could not be loaded.')}</p>;
  } else {
    body = <div className="flex flex-col gap-3">
      {items.length === 0 ? <EmptyState compact icon={<FileVideo />} title="No evidence yet"
        description="Players can attach clips or links from Discord; you can add files or links here." />
        : <ul aria-label="Evidence, oldest first" className="flex flex-col gap-0.5">
          {items.map(item => <li key={item.id}>
            <EvidenceRow snapshot={snapshot} item={item} selected={item.id === selected?.id} onSelect={() => setSelectedId(item.id)} />
          </li>)}
        </ul>}
      {selected && <section aria-label="Selected evidence" className="flex flex-col gap-2 border-t border-line pt-3">
        <EvidenceCaseTools snapshot={snapshot} item={selected} matchId={matchId} />
        {pair && <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={sideBySide} onChange={event => setSideBySide(event.target.checked)} />
          Play both players' recordings side by side
        </label>}
        {pair && sideBySide
          ? <SyncedVoicePlayer key={`${pair[0].id}:${pair[1].id}`} tracks={pair}
            labels={[submitterLabel(snapshot, pair[0]), submitterLabel(snapshot, pair[1])]}
            markers={flagMarkers(volumeFlags, Math.min(recordingStart(pair[0]), recordingStart(pair[1])),
              Math.max(pair[0].durationMs ?? 0, pair[1].durationMs ?? 0), snapshot)} />
          : <EvidencePlayer key={selected.id} item={selected}
            markers={selected.kind === 'voice' ? flagMarkers(volumeFlags, recordingStart(selected), selected.durationMs, snapshot) : []} />}
        {selected.status !== 'deleted' && <div className="flex flex-wrap items-center gap-2">
          {selected.kind !== 'link' && selected.status === 'stored' && selected.playable && <EvidenceDownloadButton item={selected} />}
          {access.manage && <>
            <Button size="sm" variant="secondary" disabled={pending}
              icon={selected.hold ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
              onClick={() => void run(() => setEvidenceHold(api, selected.id, !selected.hold))}>
              {selected.hold ? 'Unhold' : 'Hold'}
            </Button>
            <Button size="sm" variant="danger" disabled={pending} icon={<Trash2 aria-hidden />}
              onClick={() => setDeleting(selected)}>Delete</Button>
          </>}
          {selected.hold && <span className="text-2xs text-fg-subtle">Held items are never deleted automatically.</span>}
        </div>}
        {actionError && <p role="alert" className="text-xs text-danger">{actionError}</p>}
      </section>}
      {access.manage && <AddEvidence eventId={snapshot.eventId} matchId={matchId}
        onAdded={item => { update(item); setSelectedId(item.id); }} onBusyChange={setUploading} />}
    </div>;
  }

  return <>
    <Dialog open={open} onClose={onClose} title={title} description={description} layout="drawer" width="lg"
      dismissible={!uploading}>
      {body}
    </Dialog>
    <ConfirmDialog open={deleting !== null} danger requireReason pending={pending}
      title="Delete this evidence?" confirmLabel="Delete evidence"
      description="The stored file is removed and cannot be recovered. The deletion and your reason are kept in the audit."
      reasonLabel="Reason" reasonPlaceholder="Why is this evidence being deleted?"
      onCancel={() => setDeleting(null)}
      onConfirm={reason => {
        const target = deleting;
        if (!target) return;
        const invalid = validateDeleteReason(reason);
        if (invalid) { setActionError(invalid); setDeleting(null); return; }
        void run(() => deleteEvidence(api, target.id, reason)).then(() => setDeleting(null));
      }} />
  </>;
}

/** "Evidence (n)" button that opens the drawer; renders nothing without evidence.read. */
export function EvidenceButton({ snapshot, matchId, variant = 'button' }: {
  snapshot: EventSnapshotDto; matchId: MatchId; variant?: 'button' | 'cell';
}) {
  const access = useEvidenceAccess();
  const [open, setOpen] = useState(false);
  const list = useEvidenceList(snapshot.eventId, matchId, access.read);
  if (!access.read) return null;
  const count = list.data?.items.filter(item => item.status !== 'deleted').length;
  const label = count === undefined ? 'Evidence' : `Evidence (${count})`;
  // React events bubble through portals: keep clicks and keys in the button and drawer away from table rows.
  return <span className="contents" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Button size="sm" variant={variant === 'cell' ? 'ghost' : 'secondary'} icon={<FileVideo aria-hidden />}
      aria-label={`${label} for ${matchId}`} onClick={() => setOpen(true)}
      className={variant === 'cell' ? 'h-6 px-1.5' : undefined}>
      {variant === 'cell' ? (count ?? '–') : label}
    </Button>
    <EvidenceDrawer open={open} onClose={() => setOpen(false)} snapshot={snapshot} matchId={matchId} />
  </span>;
}
