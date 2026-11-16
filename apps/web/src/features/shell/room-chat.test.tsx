import { CAPABILITIES, type MatchRoomTranscriptDto, type MatchRoomTranscriptSummaryDto } from '@tcg-live/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { ToastProvider } from '../../ui';
import { NO_CONTENT_NOTE, RoomChatPanel } from './RoomChatPanel';

MotionGlobalConfig.skipAnimations = true;

const full = (patch: Partial<MatchRoomTranscriptDto> = {}): MatchRoomTranscriptDto => ({ id: 't1', eventId: 'event-1', matchId: 'M3', channelId: '200000000000000003',
  channelName: '🎮 M3', startedAtMs: 1, archivedAtMs: Date.now() - 120_000, reason: 'reassigned', messageCount: 2, contentAvailable: true, skippedOld: 0, hold: false,
  messages: [
    { id: '1', authorId: '400000000000000001', authorName: 'Ann', createdAtMs: Date.now() - 300_000, content: 'good game', attachments: [] },
    { id: '2', authorId: '400000000000000002', authorName: 'Ben', createdAtMs: Date.now() - 290_000, content: null,
      attachments: [{ name: 'board.png', url: 'https://cdn.example/board.png', size: 12 }] }],
  ...patch });
const summaryOf = ({ messages: _messages, ...summary }: MatchRoomTranscriptDto): MatchRoomTranscriptSummaryDto => summary;

function mount(setup: (server: FakeServer) => void, capabilities: readonly string[] = CAPABILITIES) {
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /session', () => json(200, { ...sessionFixture, adminTools: true, capabilities }));
    setup(server);
  } });
  render(<ToastProvider><AdminDataProvider data={harness.data}><RoomChatPanel eventId="event-1" matchId="M3" /></AdminDataProvider></ToastProvider>);
  return harness;
}

describe('RoomChatPanel', () => {
  it('lists the match transcripts and opens one to read the messages and attachments', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => {
      server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [summaryOf(full())]));
      server.always('GET /admin-tools/match-rooms/transcripts/t1', () => json(200, full()));
    });
    const list = within(await screen.findByRole('list', { name: 'Room chat transcripts for M3' }));
    expect(list.getByText('🎮 M3')).toBeInTheDocument();
    expect(list.getByText(/Room reused for another match/)).toHaveTextContent('2 messages');
    expect(server.callsTo('GET /admin-tools/match-rooms/transcripts')[0]?.url).toContain('matchId=M3');
    const view = list.getByRole('button', { name: 'View room chat from 🎮 M3' });
    await user.click(view);
    expect(view).toHaveAccessibleName('Hide room chat from 🎮 M3');
    const messages = within(await screen.findByRole('list', { name: 'Room chat messages' }));
    expect(messages.getByText('good game')).toBeInTheDocument();
    expect(messages.getByRole('link', { name: 'board.png' })).toHaveAttribute('href', 'https://cdn.example/board.png');
    expect(screen.queryByText(NO_CONTENT_NOTE)).not.toBeInTheDocument();
  });

  it('says message text needs the Message Content intent when the transcript has none', async () => {
    const user = userEvent.setup();
    const bare = full({ contentAvailable: false, skippedOld: 2,
      messages: [{ id: '1', authorId: '400000000000000001', authorName: 'Ann', createdAtMs: Date.now(), content: null, attachments: [] }] });
    mount(server => {
      server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [summaryOf(bare)]));
      server.always('GET /admin-tools/match-rooms/transcripts/t1', () => json(200, bare));
    });
    expect(await screen.findByText('No message text')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View room chat from 🎮 M3' }));
    expect(await screen.findByRole('note')).toHaveTextContent('Message text needs the Message Content intent');
    expect(screen.getByText('Text not available.')).toBeInTheDocument();
    expect(screen.getByText(/2 messages were older than\s+14 days/)).toBeInTheDocument();
  });

  it('holds a transcript with the switch', async () => {
    const user = userEvent.setup();
    const { server } = mount(server => {
      server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [summaryOf(full())]));
      server.always('GET /admin-tools/match-rooms/transcripts/t1', () => json(200, full()));
      server.always('PATCH /admin-tools/match-rooms/transcripts/t1', () => json(200, {}));
    });
    await user.click(await screen.findByRole('button', { name: 'View room chat from 🎮 M3' }));
    const hold = await screen.findByRole('switch', { name: 'Hold transcript' });
    expect(hold).toHaveAttribute('aria-checked', 'false');
    await user.click(hold);
    await waitFor(() => expect(server.callsTo('PATCH /admin-tools/match-rooms/transcripts/t1')[0]?.body).toEqual({ hold: true }));
  });

  it('only lets people who can manage the server change the hold', async () => {
    const user = userEvent.setup();
    mount(server => {
      server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [summaryOf(full({ hold: true }))]));
      server.always('GET /admin-tools/match-rooms/transcripts/t1', () => json(200, full({ hold: true })));
    }, ['members.read', 'dashboard.read']);
    expect(await screen.findByText('Held')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View room chat from 🎮 M3' }));
    expect(await screen.findByRole('switch', { name: 'Hold transcript' })).toBeDisabled();
  });

  it('says so when nothing was saved, and shows the server text when it cannot load', async () => {
    mount(server => server.always('GET /admin-tools/match-rooms/transcripts', () => json(200, [])));
    expect(await screen.findByText(/No room chat was saved for M3/)).toBeInTheDocument();
  });

  it('shows the 503 text when the bot is not connected', async () => {
    mount(server => server.always('GET /admin-tools/match-rooms/transcripts', () => json(503, { error: { code: 'unavailable', message: 'Rooms are available once the bot is connected' } })));
    expect(await screen.findByText('Rooms are available once the bot is connected')).toBeInTheDocument();
  });
});
