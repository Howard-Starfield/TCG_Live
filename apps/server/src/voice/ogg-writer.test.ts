import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOggPage, OggOpusWriter, oggCrc32, OPUS_SILENCE_FRAME, opusPacketSamples, PAGE_BOS, PAGE_EOS, readOggPages } from './ogg-writer.js';

// TOC 0xfc: CELT fullband 20 ms, stereo, one frame (960 samples).
const packet = (marker: number, size = 60) => Buffer.concat([Buffer.from([0xfc]), Buffer.alloc(size - 1, marker)]);

function record(run: (writer: OggOpusWriter) => void, startMs = 1_000) {
  const pages: Buffer[] = [];
  const writer = new OggOpusWriter(page => pages.push(page), { startMs, serial: 0x1234, pageMs: 200 });
  run(writer);
  return { data: Buffer.concat(pages), writer };
}

test('CRC32 matches the Ogg polynomial reference value', () => {
  // Reference: CRC-32/MPEG-2 without init/xorout ("CRC-32/BZIP2" unreflected, init 0): '123456789' -> 0x89a1897f.
  assert.equal(oggCrc32(Buffer.from('123456789')), 0x89a1897f);
});

test('TOC parsing gives samples per packet at 48 kHz', () => {
  assert.equal(opusPacketSamples(Buffer.from([0xfc])), 960);
  assert.equal(opusPacketSamples(OPUS_SILENCE_FRAME), 960);
  assert.equal(opusPacketSamples(Buffer.from([0x18])), 2880); // SILK NB 60 ms, one frame
  assert.equal(opusPacketSamples(Buffer.from([0x19])), 5760); // SILK NB 60 ms, two frames
  assert.equal(opusPacketSamples(Buffer.from([0x93, 0x03])), 1440); // CELT NB 10 ms, code 3, three frames
  assert.equal(opusPacketSamples(Buffer.alloc(0)), 0);
});

test('headers parse, every page CRC is valid, granules count samples and the original packets are kept', () => {
  const { data, writer } = record(w => { for (let index = 0; index < 25; index += 1) w.writePacket(packet(index), 1_000 + index * 20); w.close(); });
  const { pages, validLength } = readOggPages(data);
  assert.equal(validLength, data.length);
  assert.ok(pages.every(page => page.crcValid && page.serial === 0x1234));
  assert.deepEqual(pages.map(page => page.sequence), pages.map((_, index) => index));
  assert.equal(pages[0]!.flags, PAGE_BOS);
  const head = pages[0]!.packets[0]!;
  assert.equal(head.toString('latin1', 0, 8), 'OpusHead');
  assert.equal(head[8], 1);
  assert.equal(head[9], 2);
  assert.equal(head.readUInt32LE(12), 48_000);
  assert.equal(pages[1]!.packets[0]!.toString('latin1', 0, 8), 'OpusTags');
  assert.equal(pages[1]!.granule, 0n);
  assert.ok(pages.at(-1)!.flags & PAGE_EOS);
  const audio = pages.slice(2).flatMap(page => page.packets);
  assert.equal(audio.length, 25);
  assert.ok(audio.every((item, index) => item.equals(packet(index))), 'packets are written unchanged');
  // Each audio page's granule is the sample count at the end of its last packet.
  let samples = 0n;
  for (const page of pages.slice(2)) { samples += BigInt(page.packets.length * 960); assert.equal(page.granule, samples); }
  assert.equal(writer.durationMs, 500);
});

test('gaps are filled with silence so the timeline stays on wall-clock time; jitter is not', () => {
  const { data } = record(w => {
    w.writePacket(packet(1), 1_000);
    w.writePacket(packet(2), 1_050); // 30 ms late: jitter, no silence
    w.writePacket(packet(3), 3_000); // ~1.96 s gap
    w.close();
  });
  const audio = readOggPages(data).pages.slice(2).flatMap(page => page.packets);
  const silence = audio.filter(item => item.equals(OPUS_SILENCE_FRAME)).length;
  const third = audio.findIndex(item => item.equals(packet(3)));
  assert.equal(audio.findIndex(item => item.equals(packet(2))), 1, 'jitter inserts no silence');
  assert.equal(silence, 98);
  assert.equal(third, 2 + silence);
  assert.equal(third * 20, 2_000, 'packet 3 lands at its wall-clock offset');
});

test('close pads trailing silence to the stop time; a truncated file keeps its intact prefix', () => {
  const { data, writer } = record(w => { w.writePacket(packet(1), 1_000); w.close(2_000); });
  assert.ok(Math.abs(writer.durationMs - 1_000) <= 120);
  const cut = readOggPages(data.subarray(0, data.length - 5));
  assert.ok(cut.validLength < data.length - 5);
  assert.ok(cut.pages.length >= 2);
  const corrupt = Buffer.from(data);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
  assert.ok(readOggPages(corrupt).pages.length < readOggPages(data).pages.length);
});

test('buildOggPage laces a 255-byte packet with a trailing zero segment', () => {
  const page = buildOggPage(1, 0, 960n, 0, [Buffer.alloc(255, 1)]);
  assert.equal(page[26], 2);
  assert.deepEqual([page[27], page[28]], [255, 0]);
  assert.equal(readOggPages(page).pages[0]!.packets[0]!.length, 255);
});
