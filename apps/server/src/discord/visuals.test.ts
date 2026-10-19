import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Collection, type TextChannel } from 'discord.js';
import { createFixture, type EventState, type MatchState } from '../rehearsal/domain.js';
import { renderCard } from './cards.js';
import { discordTransport } from './runtime.js';
import { filenameFromThumbnail, noticeEmbed, visualFile, visualFilename, visualThumbnail } from './visuals.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const state = createFixture(eventId);
const image = (source: EventState, runner?: string) => renderCard(source, 'M1', runner).embeds[0]!.thumbnail?.url;
const changed = (match: Partial<MatchState>): EventState => ({ ...state,
  matches: [{ ...state.matches[0], ...match }, state.matches[1]] });

function gifFrames(bytes: Buffer): number {
  let offset = 13;
  const globalPacked = bytes[10]!;
  if (globalPacked & 0x80) offset += 3 * 2 ** ((globalPacked & 7) + 1);
  let frames = 0;
  const blocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (!size) return;
      offset += size;
    }
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++]!;
    if (kind === 0x3b) break;
    if (kind === 0x21) { offset++; blocks(); continue; }
    if (kind !== 0x2c) throw new Error('Invalid GIF block.');
    frames++;
    const packed = bytes[offset + 8]!;
    offset += 9;
    if (packed & 0x80) offset += 3 * 2 ** ((packed & 7) + 1);
    offset++;
    blocks();
  }
  return frames;
}

test('all packaged visuals are small valid PNG/GIF assets with bounded dimensions', async () => {
  const states = ['signup', 'checkin', 'setup', 'running', 'paused', 'proposal', 'disputed',
    'expired', 'final', 'reminder', 'notice', 'error'] as const;
  for (const state of states) {
    const filename = visualFilename(state);
    const bytes = await readFile(visualFile(filename)!.attachment);
    assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, `${filename} size`);
    if (filename.endsWith('.png')) {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename} PNG magic`);
      assert.ok(bytes.readUInt32BE(16) <= 128 && bytes.readUInt32BE(20) <= 128, `${filename} dimensions`);
    } else {
      assert.match(bytes.toString('ascii', 0, 6), /^GIF8[79]a$/, `${filename} GIF magic`);
      assert.ok(bytes.readUInt16LE(6) <= 128 && bytes.readUInt16LE(8) <= 128, `${filename} dimensions`);
      assert.ok(gifFrames(bytes) >= 2, `${filename} animation frames`);
    }
  }
});

test('match visual priority preserves text, color and controls', () => {
  assert.equal(image(state), 'attachment://tcg-setup-v1.gif');
  const running = changed({ phase: 'running', startedAtMs: 1_000, runnerId: 'runner' });
  assert.equal(image(running, 'runner'), 'attachment://tcg-running-v1.gif');
  assert.equal(image(running, 'other'), 'attachment://tcg-error-v1.png');
  const proposal = { revision: 1, winner: 'A' as const, reporter: 'A' as const, decision: 'open' as const };
  assert.equal(image(changed({ phase: 'paused', proposal })), 'attachment://tcg-proposal-v1.gif');
  assert.equal(image(changed({ phase: 'paused', proposal: { ...proposal, decision: 'disputed' } })),
    'attachment://tcg-disputed-v1.png');
  assert.equal(image(changed({ phase: 'paused' })), 'attachment://tcg-paused-v1.gif');
  assert.equal(renderCard(changed({ phase: 'paused' }), 'M1').embeds[0]?.color, 0xef4444);
  assert.equal(image(changed({ phase: 'expired' })), 'attachment://tcg-expired-v1.png');
  assert.equal(image(changed({ phase: 'final', finalWinner: 'A', proposal })), 'attachment://tcg-final-v1.gif');
  assert.equal(renderCard(changed({ phase: 'final', finalWinner: 'A' }), 'M1').embeds[0]?.color, 0x22c55e);
  assert.equal(renderCard(changed({ phase: 'paused', proposal }), 'M1').embeds[0]?.color, 0xef4444);
});

test('signup, check-in and published cards retain all controls with a local thumbnail', () => {
  const signup = { ...state, schemaVersion: 2 as const, signup: { status: 'open' as const, roster: [] } };
  assert.equal(renderCard(signup, 'checkin').embeds[0]?.thumbnail?.url, 'attachment://tcg-signup-v1.gif');
  assert.equal(renderCard(state, 'checkin').embeds[0]?.thumbnail?.url, 'attachment://tcg-checkin-v1.gif');
  assert.equal(renderCard({ ...state, published: true }, 'checkin').embeds[0]?.thumbnail?.url,
    'attachment://tcg-notice-v1.gif');
  assert.deepEqual(renderCard(signup, 'checkin').components[0]?.components.map(button => button.label), ['Join', 'Withdraw']);
  assert.equal(renderCard(state, 'checkin').components[0]?.components[0]?.label, 'Check in');
});

test('visual catalog accepts only known local filenames; notice text stays in embed', () => {
  assert.equal(visualFilename('running'), 'tcg-running-v1.gif');
  assert.equal(filenameFromThumbnail(visualThumbnail('running')), 'tcg-running-v1.gif');
  assert.equal(filenameFromThumbnail({ url: 'https://example.invalid/image.gif' }), null);
  assert.equal(visualFile('../secret'), null);
  assert.match(visualFile('tcg-running-v1.gif')!.attachment, /apps[\\/]server[\\/]assets[\\/]discord[\\/]tcg-running-v1\.gif$/);
  assert.deepEqual(noticeEmbed('No change: checkin.').description, 'No change: checkin.');
  assert.equal(noticeEmbed('Saved: publish.').thumbnail.url, 'attachment://tcg-final-v1.gif');
  assert.equal(noticeEmbed('Saved: publish. Room setup pending.').thumbnail.url, 'attachment://tcg-notice-v1.gif');
  assert.equal(noticeEmbed('This control is stale.').thumbnail.url, 'attachment://tcg-error-v1.png');
});

test('card transport uploads once, retains exact fetched file and replaces any stale attachment', async () => {
  const sends: unknown[] = [];
  const edits: unknown[] = [];
  let attachments = new Collection<string, { name: string }>();
  const channel = { async send(options: unknown) { sends.push(options); return { id: 'message' }; },
    messages: { async fetch() { return { attachments, async edit(options: unknown) { edits.push(options); } }; } } };
  const transport = discordTransport(channel as unknown as TextChannel);
  const setup = renderCard(state, 'M1');
  await transport.send(setup, 'M1');
  const sent = sends[0] as { files: Array<{ name: string }>; embeds: Array<{ thumbnail: { url: string } }> };
  assert.deepEqual(sent.files.map(file => file.name), ['tcg-setup-v1.gif']);
  assert.equal(sent.embeds[0]?.thumbnail.url, 'attachment://tcg-setup-v1.gif');
  attachments.set('file-id', { name: 'tcg-setup-v1.gif' });
  await transport.edit('message', setup, 'M1');
  const retained = edits[0] as { files?: unknown; attachments?: unknown; embeds: Array<{ thumbnail: { url: string } }> };
  assert.equal(retained.files, undefined);
  assert.equal(retained.attachments, undefined);
  assert.equal(retained.embeds[0]?.thumbnail.url, 'attachment://tcg-setup-v1.gif');
  await transport.edit('message', renderCard(changed({ phase: 'running' }), 'M1'), 'M1');
  const replaced = edits[1] as { files: Array<{ name: string }>; attachments: unknown[] };
  assert.deepEqual(replaced.attachments, []);
  assert.deepEqual(replaced.files.map(file => file.name), ['tcg-running-v1.gif']);
  attachments = new Collection([['one', { name: 'tcg-setup-v1.gif' }], ['extra', { name: 'old.png' }]]);
  await transport.edit('message', setup, 'M1');
  assert.deepEqual((edits[2] as { attachments: unknown[] }).attachments, []);
  await transport.edit('message', { embeds: [], components: [], allowedMentions: { parse: [] } }, 'M1');
  assert.equal((edits[3] as { files?: unknown }).files, undefined, 'nonvisual fixtures remain supported');
});

test('card transport retains only its own hidden embedded asset from the destination channel', async () => {
  const botId = '555555555555555555';
  const channelId = '333333333333333333';
  const fileId = '444444444444444444';
  const name = 'tcg-setup-v1.gif';
  const ownUrl = `https://cdn.discordapp.com/attachments/${channelId}/${fileId}/${name}?ex=signed`;
  let thumbnailUrl = ownUrl;
  let authorId = botId;
  let attachments = new Collection<string, { name: string }>();
  const edits: Array<{ files?: Array<{ name: string }>; attachments?: unknown[];
    embeds: Array<{ thumbnail: { url: string } }> }> = [];
  const channel = { id: channelId, messages: { async fetch() {
    return { author: { id: authorId }, attachments, embeds: [{ thumbnail: { url: thumbnailUrl } }],
      async edit(options: typeof edits[number]) { edits.push(options); } };
  } } };
  const transport = discordTransport(channel as unknown as TextChannel, undefined, botId);
  const setup = renderCard(state, 'M1');
  const expectRetained = async () => {
    await transport.edit('message', setup, 'M1');
    const edit = edits.at(-1)!;
    assert.equal(edit.files, undefined);
    assert.equal(edit.attachments, undefined);
    assert.equal(edit.embeds[0]?.thumbnail.url, `attachment://${name}`);
  };
  const expectReplaced = async () => {
    await transport.edit('message', setup, 'M1');
    const edit = edits.at(-1)!;
    assert.deepEqual(edit.attachments, []);
    assert.deepEqual(edit.files?.map(file => file.name), [name]);
  };
  await expectRetained();
  thumbnailUrl = `https://media.discordapp.net/attachments/${channelId}/${fileId}/${name}?width=96`;
  await expectRetained();
  thumbnailUrl = `https://images.example/attachments/${channelId}/${fileId}/${name}`;
  await expectReplaced();
  thumbnailUrl = `https://cdn.discordapp.com/attachments/666666666666666666/${fileId}/${name}`;
  await expectReplaced();
  thumbnailUrl = `https://cdn.discordapp.com/attachments/${channelId}/${fileId}/tcg-running-v1.gif`;
  await expectReplaced();
  thumbnailUrl = ownUrl;
  authorId = '777777777777777777';
  await expectReplaced();
  authorId = botId;
  attachments = new Collection([['one', { name }], ['extra', { name: 'old.png' }]]);
  await expectReplaced();
});
