import { CAPABILITIES, type Capability, type EvidenceItemDto, type EvidenceListDto, type EvidenceReplyDto } from '@tcg-live/core';
import { FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { EvidenceDrawer, MatchEvidencePanel } from './index';

MotionGlobalConfig.skipAnimations = true;

const EVENT = liveDispute.eventId;
const PATH = `/events/${EVENT}/matches/M2/evidence`;
const REPLIES = `${PATH}/replies`;

function item(overrides: Partial<EvidenceItemDto>): EvidenceItemDto {
  return {
    id: '00000000-0000-4000-8000-000000000001', eventId: EVENT, matchId: 'M2', proposalRevision: null, kind: 'note',
    source: 'web', submittedBy: 'local-admin', seat: null, note: '', originalName: null, mime: null, byteSize: null, sha256: null,
    durationMs: null, externalUrl: null, playable: false, status: 'stored', hold: false, createdAtMs: FIXTURE_NOW_MS - 60_000,
    deletedAtMs: null, deleteReason: null, ...overrides
  };
}
function reply(overrides: Partial<EvidenceReplyDto>): EvidenceReplyDto {
  return { id: '00000000-0000-4000-8000-0000000000a1', eventId: EVENT, matchId: 'M2', author: 'local-admin', body: 'Please send the clip.',
    audience: 'players', status: 'delivered', deliveryError: null, discordMessageId: '900000000000000001',
    createdAtMs: FIXTURE_NOW_MS - 30_000, ...overrides };
}

function mount(options: { items?: EvidenceItemDto[]; replies?: EvidenceReplyDto[]; capabilities?: Capability[];
  setup?: (server: FakeServer, held: { items: EvidenceItemDto[]; replies: EvidenceReplyDto[] }) => void; panel?: boolean } = {}) {
  const { capabilities = [...CAPABILITIES] } = options;
  // What the server holds; a POST in a test pushes here so the background refetch agrees with it.
  const items = [...(options.items ?? [])];
  const replies = [...(options.replies ?? [])];
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, capabilities, evidence: true }));
    server.always(`GET ${PATH}`, () => json(200, { eventId: EVENT, matchId: 'M2', items } satisfies EvidenceListDto));
    server.always(`GET ${REPLIES}`, () => json(200, { eventId: EVENT, matchId: 'M2', replies }));
    options.setup?.(server, { items, replies });
  } });
  render(<AdminDataProvider data={harness.data}>
    {options.panel ? <MatchEvidencePanel eventId={EVENT} matchId="M2" />
      : <EvidenceDrawer open onClose={() => {}} snapshot={liveDispute} matchId="M2" />}
  </AdminDataProvider>);
  return harness;
}

describe('text-only evidence (kind note)', () => {
  it('saves typed text without a file or link and shows it in the list', async () => {
    const saved = item({ id: '00000000-0000-4000-8000-0000000000b1', note: 'Ben showed eight cards at turn 3.' });
    const { server } = mount({ setup: (s, held) => s.always(`POST ${PATH}`, () => { held.items.push(saved); return json(201, { item: saved }); }) });
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Text' }));
    // No file picker, no link field, no caption in Text mode.
    expect(within(form).queryByLabelText('Choose evidence file')).not.toBeInTheDocument();
    expect(within(form).queryByRole('textbox', { name: 'Link' })).not.toBeInTheDocument();
    expect(within(form).queryByRole('textbox', { name: /Note/ })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save without attachment' }));
    expect(await within(form).findByText('Type some text.')).toBeInTheDocument();
    expect(server.callsTo(`POST ${PATH}`)).toHaveLength(0);
    fireEvent.change(within(form).getByRole('textbox', { name: 'Text' }), { target: { value: '  Ben showed eight cards at turn 3.  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save without attachment' }));
    await waitFor(() => expect(server.callsTo(`POST ${PATH}`)).toHaveLength(1));
    const call = server.callsTo(`POST ${PATH}`)[0]!;
    expect(call.body).toEqual({ kind: 'note', text: 'Ben showed eight cards at turn 3.' });
    expect(call.headers['Content-Type']).toBe('application/json');
    // The saved note is selected: its text is shown in the list and in full below, with no player.
    const list = await screen.findByRole('list', { name: 'Evidence, oldest first' });
    expect(within(list).getByRole('button')).toHaveTextContent('note');
    expect(within(list).getByRole('button')).toHaveTextContent('Ben showed eight cards at turn 3.');
    expect(await screen.findByTestId('evidence-note')).toHaveTextContent('Ben showed eight cards at turn 3.');
    expect(screen.queryByTestId('evidence-media')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('refuses text over the limit before posting', async () => {
    const { server } = mount();
    const form = await screen.findByRole('form', { name: 'Add evidence' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Text' }));
    fireEvent.change(within(form).getByRole('textbox', { name: 'Text' }), { target: { value: 'x'.repeat(4001) } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save without attachment' }));
    expect(await within(form).findByText('Text can be up to 4000 characters.')).toBeInTheDocument();
    expect(server.callsTo(`POST ${PATH}`)).toHaveLength(0);
  });

  it('clamps long notes and expands them; a deleted note hides its text', async () => {
    const long = item({ id: '00000000-0000-4000-8000-0000000000b2', note: `Account. ${'word '.repeat(120)}END` });
    const gone = item({ id: '00000000-0000-4000-8000-0000000000b3', note: 'Private mistake', status: 'deleted', deletedAtMs: FIXTURE_NOW_MS,
      deleteReason: 'wrong match', createdAtMs: FIXTURE_NOW_MS - 90_000 });
    mount({ items: [gone, long] });
    const first = within(await screen.findByRole('list', { name: 'Evidence, oldest first' })).getAllByRole('button');
    fireEvent.click(first[1]!);
    const block = await screen.findByTestId('evidence-note');
    expect(block.querySelector('p')!.className).toContain('line-clamp-6');
    fireEvent.click(within(block).getByRole('button', { name: 'Show more' }));
    expect(block.querySelector('p')!.className).not.toContain('line-clamp-6');
    expect(within(block).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByRole('list', { name: 'Evidence, oldest first' })).getAllByRole('button');
    expect(rows[0]).not.toHaveTextContent('Private mistake');
    fireEvent.click(rows[0]!);
    expect(await screen.findByTestId('evidence-unavailable')).toHaveTextContent('Deleted: wrong match');
    expect(screen.queryByText('Private mistake')).not.toBeInTheDocument();
  });
});

describe('reply thread', () => {
  it('shows replies with who they went to, and a labelled "Staff note only" switch that is off by default', async () => {
    mount({ replies: [reply({}), reply({ id: '00000000-0000-4000-8000-0000000000a2', audience: 'staff', status: 'recorded', body: 'Check the VOD.',
      createdAtMs: FIXTURE_NOW_MS - 10_000 })] });
    const thread = await screen.findByRole('list', { name: 'Replies, oldest first' });
    const rows = within(thread).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Please send the clip.');
    expect(rows[0]).toHaveTextContent('To players');
    expect(rows[0]).toHaveTextContent('Delivered');
    expect(rows[1]).toHaveTextContent('Staff only');
    expect(rows[1]).toHaveTextContent('Check the VOD.');
    const toggle = screen.getByRole('switch', { name: 'Staff note only' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('textbox', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByText(/Posted in Discord to .* only they are mentioned/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Only visible in this dashboard.')).toBeInTheDocument();
  });

  it('sends to the players by default, and as a staff note when the switch is on', async () => {
    let count = 0;
    const { server } = mount({ setup: (s, held) => s.always(`POST ${REPLIES}`, call => {
      count += 1;
      const body = call.body as { body: string; audience: 'players' | 'staff' };
      const created = reply({ id: `00000000-0000-4000-8000-00000000010${count}`, body: body.body, audience: body.audience,
        status: body.audience === 'staff' ? 'recorded' : 'delivered', discordMessageId: body.audience === 'staff' ? null : '900000000000000001' });
      held.replies.push(created);
      return json(201, { reply: created });
    }) });
    const box = await screen.findByRole('textbox', { name: 'Reply' });
    fireEvent.change(box, { target: { value: '  Please send the clip.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.callsTo(`POST ${REPLIES}`)).toHaveLength(1));
    expect(server.callsTo(`POST ${REPLIES}`)[0]!.body).toEqual({ body: 'Please send the clip.', audience: 'players' });
    await waitFor(() => expect(box).toHaveValue(''));
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Staff note only' }));
    fireEvent.change(box, { target: { value: 'Internal: check the VOD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.callsTo(`POST ${REPLIES}`)).toHaveLength(2));
    expect(server.callsTo(`POST ${REPLIES}`)[1]!.body).toEqual({ body: 'Internal: check the VOD', audience: 'staff' });
  });

  it('Enter adds a newline and only Ctrl or Cmd+Enter sends, once, even when pressed twice at once', async () => {
    let release: (() => void) | undefined;
    const { server } = mount({ setup: s => s.always(`POST ${REPLIES}`, async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return json(201, { reply: reply({}) });
    }) });
    const box = await screen.findByRole('textbox', { name: 'Reply' });
    fireEvent.change(box, { target: { value: 'Line one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(server.callsTo(`POST ${REPLIES}`)).toHaveLength(0);
    expect(box).toHaveValue('Line one');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.callsTo(`POST ${REPLIES}`)).toHaveLength(1));
    release?.();
    await waitFor(() => expect(box).toHaveValue(''));
    expect(server.callsTo(`POST ${REPLIES}`)).toHaveLength(1);
  });

  it('keeps a reply Discord did not take as "Not delivered" with its reason, and Retry posts it again', async () => {
    const failed = reply({ id: '00000000-0000-4000-8000-0000000000f1', status: 'failed', discordMessageId: null,
      deliveryError: 'The bot is not allowed to post in this match room. Check its channel permissions.' });
    let delivered = false;
    const { server } = mount({ replies: [failed], setup: s => {
      s.always(`GET ${REPLIES}`, () => json(200, { eventId: EVENT, matchId: 'M2', replies: [delivered ? reply({ id: failed.id }) : failed] }));
      s.always(`POST ${REPLIES}/${failed.id}/retry`, () => { delivered = true; return json(200, { reply: reply({ id: failed.id }) }); });
    } });
    const row = await screen.findByText('Not delivered');
    expect(row).toBeInTheDocument();
    expect(screen.getByText(/not allowed to post in this match room/)).toBeInTheDocument();
    expect(screen.getByText('Please send the clip.')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /Retry/ });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(server.callsTo(`POST ${REPLIES}/${failed.id}/retry`)).toHaveLength(1));
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByText('Not delivered')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  it('shows the server reason when a reply cannot be sent at all', async () => {
    mount({ setup: s => s.always(`POST ${REPLIES}`, () => json(503, { error: { code: 'unavailable', message: 'Discord delivery is not available.' } })) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reply' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available/);
  });

  it('hides the composer and Retry without match.judge (dashboard actions off) but still shows the thread', async () => {
    mount({ capabilities: ['dashboard.read', 'evidence.read'], replies: [reply({ status: 'failed', discordMessageId: null, deliveryError: 'Down.' })] });
    expect(await screen.findByText('Not delivered')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Staff note only' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/turned on for this console/)).toBeInTheDocument();
  });

  it('MatchEvidencePanel embeds the list, the add form and the thread without a dialog', async () => {
    mount({ panel: true, items: [item({ note: 'A written account' })], replies: [reply({})] });
    expect(await screen.findByRole('list', { name: 'Evidence, oldest first' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Replies, oldest first' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Add evidence' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Reply to this match' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
