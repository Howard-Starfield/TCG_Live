import { ARTWORK_GAMES, type ArtworkProfileDto, type ArtworkSelectionDto } from '@tcg-live/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { createHarness } from '../../app/testing';
import { AdminDataProvider } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';
import { ArtworkDialog } from './ArtworkDialog';

const none: ArtworkSelectionDto = { source: 'none', contentType: null, width: null, height: null, revision: null };
const profile = { activeGame: null, games: Object.fromEntries(ARTWORK_GAMES.map(game => [game, { banner: none, thumbnail: none }])) } as
  unknown as ArtworkProfileDto;

function mount(setup: (server: FakeServer) => void) {
  const harness = createHarness({ stream: false, setup });
  render(<AdminDataProvider data={harness.data}><ArtworkDialog open onClose={() => {}} /></AdminDataProvider>);
  return harness;
}

it('loads artwork through the API client and reports network failures readably', async () => {
  const { server } = mount(server => { server.always('GET /artwork', () => Promise.reject(new TypeError('Failed to fetch'))); });
  expect(await screen.findByText('The console server could not be reached.')).toBeInTheDocument();
  expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  expect(server.callsTo('GET /artwork')[0]!.headers.Authorization).toBe('Bearer bearer-token');
});

it('uploads the image bytes unchanged with their content type', async () => {
  const { server } = mount(server => {
    server.always('GET /artwork', () => json(200, profile));
    server.always('PUT /artwork/one-piece/banner', () => json(200, { ...profile, applyStatus: 'applied' }));
  });
  const input = await screen.findByLabelText('Choose banner image');
  const file = new File([new Uint8Array([71, 73, 70])], 'banner.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(server.callsTo('PUT /artwork/one-piece/banner')).toHaveLength(1));
  const call = server.callsTo('PUT /artwork/one-piece/banner')[0]!;
  expect(call.headers['Content-Type']).toBe('image/png');
  expect(call.headers.Authorization).toBe('Bearer bearer-token');
  expect(await screen.findByText('Saved and updated the existing Discord panels.')).toBeInTheDocument();
});
