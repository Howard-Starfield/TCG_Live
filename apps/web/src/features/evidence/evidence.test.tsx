import { CAPABILITIES, type Capability, type EventSnapshotDto, type EvidenceItemDto, type EvidenceListDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { validateEvidenceUrl } from './api';
import { EvidenceButton, EvidenceDrawer } from './EvidenceDrawer';
import { TICKET_REFRESH_MARGIN_MS } from './EvidencePlayer';

MotionGlobalConfig.skipAnimations = true;

const EVENT = liveDispute.eventId;
const PATH = `/events/${EVENT}/matches/M2/evidence`;

function item(overrides: Partial<EvidenceItemDto>): EvidenceItemDto {
  return {
    id: '00000000-0000-4000-8000-000000000001', eventId: EVENT, matchId: 'M2', proposalRevision: 1, kind: 'upload',
    source: 'discord', submittedBy: 'local-admin', seat: null, note: '', originalName: null, mime: 'video/mp4',
    byteSize: 5 * 1024 * 1024, sha256: null, durationMs: 90_000, externalUrl: null, playable: true, status: 'stored',
    hold: false, createdAtMs: FIXTURE_NOW_MS - 60_000, deletedAtMs: null, deleteReason: null, ...overrides
  };
}

const clip = item({ id: '00000000-0000-4000-8000-00000000000a', seat: 'D', note: 'Clip of the last turn', originalName: 'turn.mp4',
  createdAtMs: FIXTURE_NOW_MS - 30_000 });
const link = item({ id: '00000000-0000-4000-8000-00000000000b', kind: 'link', seat: 'C', mime: null, byteSize: null, durationMs: null,
  externalUrl: 'https://streamable.com/abc', note: 'Stream VOD', hold: true, createdAtMs: FIXTURE_NOW_MS - 120_000 });

function mount(options: { items?: EvidenceItemDto[]; capabilities?: Capability[]; evidence?: boolean;
  setup?: (server: FakeServer) => void; button?: boolean; onClose?: () => void } = {}) {
  const { items = [clip, link], capabilities = [...CAPABILITIES], evidence = true } = options;
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities, ...(evidence ? { evidence: true } : {}) }));
    server.always(`GET ${PATH}`, () => json(200, { eventId: EVENT, matchId: 'M2', items } satisfies EvidenceListDto));
    server.always(`GET ${PATH}/replies`, () => json(200, { eventId: EVENT, matchId: 'M2', replies: [] }));
    server.always('POST /evidence/00000000-0000-4000-8000-00000000000a/playback',
      () => json(200, { url: '/api/v1/media/ticket-one', expiresAtMs: FIXTURE_NOW_MS + 15 * 60_000 }));
    options.setup?.(server);
  } });
  const onClose = options.onClose ?? (() => {});
  const ui = (snapshot: EventSnapshotDto, open = true) => <AdminDataProvider data={harness.data}>
    {options.button ? <EvidenceButton snapshot={snapshot} matchId="M2" />
      : <EvidenceDrawer open={open} onClose={onClose} snapshot={snapshot} matchId="M2" />}
  </AdminDataProvider>;
  const view = render(ui(liveDispute));
  return { ...harness, rerender: (snapshot: EventSnapshotDto, open?: boolean) => view.rerender(ui(snapshot, open)), unmount: view.unmount };
}

describe('EvidenceDrawer', () => {
  it('lists evidence oldest first with submitter, kind, note, size and hold, and plays the selected file by ticket', async () => {
    const { server } = mount();
    const list = await screen.findByRole('list', { name: 'Evidence, oldest first' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Seat C');
    expect(rows[0]).toHaveTextContent('link');
    expect(rows[0]).toHaveTextContent('hold');
    expect(rows[1]).toHaveTextContent('Seat D');
    expect(rows[1]).toHaveTextContent('Clip of the last turn');
    expect(rows[1]).toHaveTextContent('5.0 MB · 1:30');
    const media = await screen.findByTestId('evidence-media');
    expect(media).toHaveAttribute('src', '/api/v1/media/ticket-one');
    expect(server.callsTo('POST /evidence/00000000-0000-4000-8000-00000000000a/playback')[0]!.headers.Authorization).toBe('Bearer bearer-token');
  });

  it('opens link evidence only in a new tab with noopener and an external-link warning', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Stream VOD/ }));
    const anchor = await screen.findByRole('link', { name: /Open link in new tab/ });
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('External link to streamable.com');
  });

  it('offers download only for files the browser cannot play', async () => {
    mount({ items: [item({ id: '00000000-0000-4000-8000-00000000000c', mime: 'video/x-matroska', playable: false })] });
    expect(await screen.findByTestId('evidence-download-only')).toHaveTextContent('cannot play in the browser');
    expect(screen.queryByTestId('evidence-media')).not.toBeInTheDocument();
  });

  it('fetches a new ticket before the old one expires and after a playback error', async () => {
    let issued = 0;
    const { server } = mount({ items: [clip], setup: server => {
      server.always('POST /evidence/00000000-0000-4000-8000-00000000000a/playback', () => {
        issued += 1;
        // The first ticket is about to expire: the refresh is due 40 ms from now.
        return json(200, { url: `/api/v1/media/ticket-${issued}`,
          expiresAtMs: FIXTURE_NOW_MS + (issued === 1 ? TICKET_REFRESH_MARGIN_MS + 40 : 15 * 60_000) });
      });
    } });
    const key = 'POST /evidence/00000000-0000-4000-8000-00000000000a/playback';
    await waitFor(() => expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/ticket-2'));
    expect(server.callsTo(key)).toHaveLength(2);
    // A revoked ticket (401/403/404) surfaces only as a media error: ask for a fresh one.
    fireEvent.error(screen.getByTestId('evidence-media'));
    await waitFor(() => expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/ticket-3'));
  });

  it('does not loop when every ticket arrives already near expiry (clock skew or a short TTL)', async () => {
    const { server } = mount({ items: [clip], setup: server => {
      server.always('POST /evidence/00000000-0000-4000-8000-00000000000a/playback',
        () => json(200, { url: '/api/v1/media/short', expiresAtMs: FIXTURE_NOW_MS }));
    } });
    const key = 'POST /evidence/00000000-0000-4000-8000-00000000000a/playback';
    await screen.findByTestId('evidence-media');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(server.callsTo(key).length).toBeLessThanOrEqual(2);
  });

  it('validates links before posting and posts url and note as JSON', async () => {
    const { server } = mount({ setup: server => {
      server.always(`POST ${PATH}`, () => json(201, { item: item({ id: '00000000-0000-4000-8000-00000000000d', kind: 'link',
        externalUrl: 'https://youtu.be/x', note: 'Angle 2' }) }));
    } });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Paste link' }));
    const input = within(form).getByRole('textbox', { name: 'Link' });
    fireEvent.change(input, { target: { value: 'http://youtu.be/x' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add link' }));
    expect(await within(form).findByText('Use an https:// link.')).toBeInTheDocument();
    expect(server.callsTo(`POST ${PATH}`)).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'https://youtu.be/x' } });
    fireEvent.change(within(form).getByRole('textbox', { name: /Note/ }), { target: { value: 'Angle 2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(server.callsTo(`POST ${PATH}`)).toHaveLength(1));
    const call = server.callsTo(`POST ${PATH}`)[0]!;
    expect(call.body).toEqual({ url: 'https://youtu.be/x', note: 'Angle 2' });
    expect(call.headers['Content-Type']).toBe('application/json');
  });

  it('uploads the file unchanged with a media Content-Type and the note in the query', async () => {
    const { server } = mount({ setup: server => {
      server.always(`POST ${PATH}`, () => json(201, { item: item({ id: '00000000-0000-4000-8000-00000000000e', playable: false,
        mime: 'video/x-matroska', originalName: 'match.mkv' }) }));
    } });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    const file = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'match.mkv', { type: '' });
    fireEvent.change(within(form).getByLabelText('Choose evidence file'), { target: { files: [file] } });
    fireEvent.change(within(form).getByRole('textbox', { name: /Note/ }), { target: { value: 'Full game' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(server.callsTo(`POST ${PATH}`)).toHaveLength(1));
    const call = server.callsTo(`POST ${PATH}`)[0]!;
    expect(call.url).toContain(`${PATH}?note=Full%20game`);
    expect(call.headers['Content-Type']).toBe('video/x-matroska');
    expect(call.headers.Authorization).toBe('Bearer bearer-token');
  });

  it('requires a reason before deleting', async () => {
    const { server } = mount({ setup: server => {
      server.always(`DELETE /evidence/${clip.id}`, () => json(200, { item: { ...clip, status: 'deleted', deleteReason: 'Wrong match' } }));
    } });
    await screen.findByTestId('evidence-media');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this evidence?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete evidence' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: '  Wrong match ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(server.callsTo(`DELETE /evidence/${clip.id}`)).toHaveLength(1));
    expect(server.callsTo(`DELETE /evidence/${clip.id}`)[0]!.body).toEqual({ reason: 'Wrong match' });
  });

  it('toggles hold through PATCH', async () => {
    let held = false;
    const { server } = mount({ setup: server => {
      server.always(`GET ${PATH}`, () => json(200, { eventId: EVENT, matchId: 'M2', items: [{ ...clip, hold: held }, link] }));
      server.always(`PATCH /evidence/${clip.id}`, () => { held = true; return json(200, { item: { ...clip, hold: true } }); });
    } });
    await screen.findByTestId('evidence-media');
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(server.callsTo(`PATCH /evidence/${clip.id}`)[0]?.body).toEqual({ hold: true }));
    expect(await screen.findByRole('button', { name: 'Unhold' })).toBeInTheDocument();
  });

  it('hides add, hold and delete without evidence.manage', async () => {
    mount({ capabilities: ['dashboard.read', 'evidence.read'] });
    await screen.findByTestId('evidence-media');
    expect(screen.queryByRole('form', { name: 'Add evidence' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('keeps the media src across parent re-renders (live stream updates)', async () => {
    const { rerender } = mount({ items: [clip] });
    const media = await screen.findByTestId('evidence-media');
    expect(media).toHaveAttribute('src', '/api/v1/media/ticket-one');
    for (let version = 1; version <= 3; version += 1) {
      rerender({ ...liveDispute, version: liveDispute.version + version });
      await act(async () => { await Promise.resolve(); });
    }
    expect(screen.getByTestId('evidence-media')).toBe(media);
    expect(media).toHaveAttribute('src', '/api/v1/media/ticket-one');
  });

  it('releases the media element when the drawer unmounts', async () => {
    const { unmount } = mount({ items: [clip] });
    const media = await screen.findByTestId('evidence-media');
    const load = vi.spyOn(media as HTMLMediaElement, 'load').mockImplementation(() => {});
    vi.spyOn(media as HTMLMediaElement, 'pause').mockImplementation(() => {});
    unmount();
    expect(media).not.toHaveAttribute('src');
    expect(load).toHaveBeenCalled();
  });

  it('stays on the event it was opened for when the active event changes', async () => {
    const { server, rerender } = mount({ items: [clip] });
    await screen.findByTestId('evidence-media');
    rerender({ ...liveDispute, eventId: 'another-event', matches: [] });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(server.callsTo('GET /events/another-event/matches/M2/evidence')).toHaveLength(0);
    expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/ticket-one');
    expect(screen.getByText(/earlier event/)).toBeInTheDocument();
    expect(screen.queryByText('No evidence yet')).not.toBeInTheDocument();
  });

  it('closes on Escape while typing in the note', async () => {
    const onClose = vi.fn();
    mount({ onClose });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    const note = within(form).getByRole('textbox', { name: /Note/ });
    note.focus();
    fireEvent.keyDown(note, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape when focus fell to the page body (a control disabled during upload)', async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await screen.findByRole('form', { name: 'Add evidence' });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close only the delete confirmation, not the drawer', async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await screen.findByTestId('evidence-media');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this evidence?' });
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: /Reason/ }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says when the server does not ship evidence yet (501)', async () => {
    mount({ setup: server => {
      server.always(`GET ${PATH}`, () => json(501, { error: { code: 'unavailable', message: 'Evidence is not available in this version yet.' } }));
    } });
    expect(await screen.findByText('Evidence is not available in this version yet.')).toBeInTheDocument();
  });
});

describe('EvidenceButton', () => {
  it('shows the count and opens the drawer', async () => {
    mount({ button: true });
    const button = await screen.findByRole('button', { name: 'Evidence (2) for M2' });
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'M2 evidence' })).toBeInTheDocument();
  });

  it('renders nothing without evidence.read or when the runtime does not mount evidence', async () => {
    const { server } = mount({ button: true, capabilities: ['dashboard.read'] });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByRole('button', { name: /Evidence/ })).not.toBeInTheDocument();
    expect(server.callsTo(`GET ${PATH}`)).toHaveLength(0);
  });

  it('stays hidden when the session lacks the evidence runtime flag', async () => {
    mount({ button: true, evidence: false });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByRole('button', { name: /Evidence/ })).not.toBeInTheDocument();
  });
});

describe('validateEvidenceUrl', () => {
  it('accepts https links only', () => {
    expect(validateEvidenceUrl('https://medal.tv/clip/1')).toBeNull();
    expect(validateEvidenceUrl('javascript:alert(1)')).toBe('Use an https:// link.');
    expect(validateEvidenceUrl('not a link')).toBe('That is not a valid link.');
    expect(validateEvidenceUrl(`https://x.test/${'a'.repeat(2100)}`)).toMatch(/up to 2048/);
    expect(validateEvidenceUrl('https://user:pw@x.test/')).toMatch(/user name/);
  });
});

describe('playback robustness', () => {
  const key = 'POST /evidence/00000000-0000-4000-8000-00000000000a/playback';
  const failWith = (element: HTMLElement, code: number) => {
    Object.defineProperty(element, 'error', { configurable: true, value: { code } });
    fireEvent.error(element);
  };

  it('switches to download only on an unsupported codec, without more tickets', async () => {
    const head = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', head);
    try {
      const { server } = mount({ items: [clip] });
      failWith(await screen.findByTestId('evidence-media'), 4);
      expect(await screen.findByTestId('evidence-download-only')).toHaveTextContent(/HEVC or ProRes/);
      expect(head).toHaveBeenCalledWith('/api/v1/media/ticket-one', expect.objectContaining({ method: 'HEAD' }));
      expect(server.callsTo(key)).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('treats "not supported" from a refused ticket as expiry and fetches a new one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    try {
      let issued = 0;
      const { server } = mount({ items: [clip], setup: server => {
        server.always(key, () => { issued += 1; return json(200, { url: `/api/v1/media/t-${issued}`, expiresAtMs: FIXTURE_NOW_MS + 15 * 60_000 }); });
      } });
      failWith(await screen.findByTestId('evidence-media'), 4);
      await waitFor(() => expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/t-2'));
      expect(server.callsTo(key)).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps playing on the old ticket and swaps the early-fetched one in at the next pause', async () => {
    let issued = 0;
    mount({ items: [clip], setup: server => {
      server.always(key, () => {
        issued += 1;
        return json(200, { url: `/api/v1/media/p-${issued}`,
          expiresAtMs: FIXTURE_NOW_MS + (issued === 1 ? TICKET_REFRESH_MARGIN_MS + 40 : 15 * 60_000) });
      });
    } });
    const media = await screen.findByTestId('evidence-media');
    // Playing: the refresh due in 40 ms must not replace src mid-playback.
    Object.defineProperty(media, 'paused', { configurable: true, value: false });
    Object.defineProperty(media, 'currentSrc', { configurable: true, value: 'http://127.0.0.1/api/v1/media/p-1' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(issued).toBe(2);
    expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/p-1');
    Object.defineProperty(media, 'paused', { configurable: true, value: true });
    fireEvent.pause(media);
    await waitFor(() => expect(screen.getByTestId('evidence-media')).toHaveAttribute('src', '/api/v1/media/p-2'));
  });
});

describe('upload feedback', () => {
  it('says when the same file was already uploaded for the match', async () => {
    mount({ setup: server => {
      server.always(`POST ${PATH}`, () => json(200, { item: clip, duplicate: true }));
    } });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    fireEvent.change(within(form).getByLabelText('Choose evidence file'),
      { target: { files: [new File([new Uint8Array([0, 0, 0, 0x18])], 'turn.mp4', { type: 'video/mp4' })] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Upload' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(/already uploaded for this match/);
  });

  it('maps upload failures to clear messages', async () => {
    const { ApiError } = await import('../../data');
    const { describeUploadError } = await import('./api');
    expect(describeUploadError(new ApiError({ code: 'network', status: 0, message: 'Network request failed' })))
      .toMatch(/connection dropped/);
    expect(describeUploadError(new ApiError({ code: 'bad_request', status: 413, message: '' }))).toMatch(/too large/);
    expect(describeUploadError(new ApiError({ code: 'bad_request', status: 415, message: '' }))).toMatch(/MP4/);
    expect(describeUploadError(new ApiError({ code: 'bad_request', status: 507, message: 'The evidence disk is full.' })))
      .toBe('The evidence disk is full.');
    expect(describeUploadError(new ApiError({ code: 'unavailable', status: 504, message: '' }))).toMatch(/timed out/);
  });

  it('estimates speed and time left from recent progress', async () => {
    const { uploadRate } = await import('./api');
    expect(uploadRate([{ atMs: 0, loaded: 0 }], 100)).toBeNull();
    expect(uploadRate([{ atMs: 0, loaded: 0 }, { atMs: 2_000, loaded: 2_000_000 }], 10_000_000))
      .toEqual({ bytesPerSecond: 1_000_000, etaMs: 8_000 });
  });

  it('asks before the tab closes while an upload is running', async () => {
    let finish!: () => void;
    mount({ setup: server => {
      server.always(`POST ${PATH}`, () => new Promise(resolve => { finish = () => resolve(json(201, { item: clip })); }));
    } });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    fireEvent.change(within(form).getByLabelText('Choose evidence file'),
      { target: { files: [new File([new Uint8Array([0, 0, 0, 0x18])], 'turn.mp4', { type: 'video/mp4' })] } });
    fireEvent.click(within(form).getByRole('button', { name: 'Upload' }));
    await within(form).findByText(/Keep this tab open/);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await act(async () => { finish(); });
    await waitFor(() => expect(within(form).queryByText(/Keep this tab open/)).not.toBeInTheDocument());
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
