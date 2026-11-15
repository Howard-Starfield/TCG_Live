// Ogg Opus muxer (RFC 7845 over RFC 3533). Writes the ORIGINAL Opus packets without re-encoding; pure:
// pages are handed to a sink. Granule positions count 48 kHz samples from the recording start, and gaps
// in the packet flow (Discord sends nothing during silence) are filled with Opus silence frames so the
// file timeline stays aligned to wall-clock time.

export const OPUS_RATE = 48_000;
const SAMPLES_PER_MS = OPUS_RATE / 1000;
/** One 20 ms CELT fullband mono silence frame (TOC 0xf8), the frame Discord itself uses for silence. */
export const OPUS_SILENCE_FRAME: Readonly<Buffer> = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE_SAMPLES = 960;

// ---- CRC32 (Ogg: polynomial 0x04c11db7, MSB first, init 0, no final xor) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    table[index] = value >>> 0;
  }
  return table;
})();
export function oggCrc32(data: Uint8Array): number {
  let crc = 0;
  for (let index = 0; index < data.length; index += 1) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[index]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export const PAGE_CONTINUED = 0x01;
export const PAGE_BOS = 0x02;
export const PAGE_EOS = 0x04;

/** Builds one page; each packet must fit on the page (an Opus packet is at most a few KB). */
export function buildOggPage(serial: number, sequence: number, granule: bigint, flags: number, packets: readonly Uint8Array[]): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) { lacing.push(255); remaining -= 255; }
    lacing.push(remaining);
  }
  if (lacing.length > 255) throw new Error('Ogg page has too many segments.');
  const bodyLength = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = Buffer.alloc(27 + lacing.length + bodyLength);
  page.write('OggS', 0, 'latin1');
  page[4] = 0;
  page[5] = flags;
  page.writeBigInt64LE(granule, 6);
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(sequence >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = lacing.length;
  Buffer.from(lacing).copy(page, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) { page.set(packet, offset); offset += packet.length; }
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

export function opusHead(channels = 2, preSkip = 0): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(OPUS_RATE, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  return head;
}

export function opusTags(vendor: string, comments: readonly string[] = []): Buffer {
  const parts = [Buffer.from('OpusTags', 'latin1')];
  const vendorBytes = Buffer.from(vendor, 'utf8');
  const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
  parts.push(u32(vendorBytes.length), vendorBytes, u32(comments.length));
  for (const comment of comments) { const bytes = Buffer.from(comment, 'utf8'); parts.push(u32(bytes.length), bytes); }
  return Buffer.concat(parts);
}

/** Samples at 48 kHz in an Opus packet, from its TOC byte (RFC 6716 §3.1); 0 for a malformed packet. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length < 1) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3]!;
  else if (config < 16) frameSamples = [480, 960][config & 1]!;
  else frameSamples = [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else { if (packet.length < 2) return 0; frames = packet[1]! & 0x3f; }
  const total = frames * frameSamples;
  return total > 5760 ? 0 : total;
}

export interface OggOpusWriterOptions {
  /** Wall-clock time of granule 0. */
  startMs: number;
  serial?: number;
  channels?: number;
  vendor?: string;
  comments?: string[];
  /** A page is flushed once it holds this much audio (bounds what a crash can lose). */
  pageMs?: number;
  /** Lag behind wall-clock tolerated as jitter before silence is inserted. */
  gapToleranceMs?: number;
  /**
   * The longest silence one fill writes. A longer jump (for example a clock step) shifts the timeline
   * instead of writing hours of silence; fillTo and writePacket return the skipped milliseconds.
   */
  maxFillMs?: number;
}

/** One logical Ogg Opus stream (one player). */
export class OggOpusWriter {
  private sequence = 0;
  private granule = 0n;
  private pending: Uint8Array[] = [];
  private pendingSegments = 0;
  private pendingSamples = 0;
  private closed = false;
  readonly serial: number;
  private startMs: number;
  private readonly maxFillSamples: number;
  private readonly pageSamples: number;
  private readonly toleranceSamples: number;
  private bytes = 0;

  constructor(private readonly sink: (page: Buffer) => void, options: OggOpusWriterOptions) {
    this.serial = (options.serial ?? (Math.random() * 0xffffffff)) >>> 0;
    this.startMs = options.startMs;
    this.pageSamples = Math.max(1, Math.round((options.pageMs ?? 1000) * SAMPLES_PER_MS));
    this.toleranceSamples = Math.round((options.gapToleranceMs ?? 100) * SAMPLES_PER_MS);
    this.maxFillSamples = options.maxFillMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.round(options.maxFillMs * SAMPLES_PER_MS));
    this.emit(buildOggPage(this.serial, this.sequence++, 0n, PAGE_BOS, [opusHead(options.channels ?? 2)]));
    this.emit(buildOggPage(this.serial, this.sequence++, 0n, 0, [opusTags(options.vendor ?? 'tcg-live voice recorder', options.comments)]));
  }

  /** Granule after every written packet, in 48 kHz samples. */
  get granulePosition(): bigint { return this.granule + BigInt(this.pendingSamples); }
  get durationMs(): number { return Number(this.granulePosition) / SAMPLES_PER_MS; }
  get bytesWritten(): number { return this.bytes; }

  /** Writes one original Opus packet that arrived at wall-clock `atMs`; returns milliseconds skipped (see maxFillMs). */
  writePacket(packet: Uint8Array, atMs: number): number {
    if (this.closed) throw new Error('Ogg writer is closed.');
    const samples = opusPacketSamples(packet);
    if (samples === 0) return 0;
    const skipped = this.fillTo(atMs);
    this.append(packet, samples);
    return skipped;
  }

  /** Inserts silence so the stream reaches wall-clock `atMs` (minus jitter tolerance); returns milliseconds skipped. */
  fillTo(atMs: number): number {
    const target = BigInt(Math.max(0, Math.round((atMs - this.startMs) * SAMPLES_PER_MS)));
    if (target - this.granulePosition <= BigInt(this.toleranceSamples)) return 0;
    let missingSamples = Number(target - this.granulePosition);
    let skippedMs = 0;
    if (missingSamples > this.maxFillSamples) {
      const skipSamples = missingSamples - this.maxFillSamples;
      skippedMs = skipSamples / SAMPLES_PER_MS;
      this.startMs += skippedMs;
      missingSamples = this.maxFillSamples;
    }
    const frames = Math.floor(missingSamples / SILENCE_SAMPLES);
    for (let index = 0; index < frames; index += 1) this.append(OPUS_SILENCE_FRAME, SILENCE_SAMPLES);
    return skippedMs;
  }

  private append(packet: Uint8Array, samples: number): void {
    const segments = Math.floor(packet.length / 255) + 1;
    if (this.pendingSegments + segments > 255) this.flush();
    this.pending.push(Buffer.from(packet));
    this.pendingSegments += segments;
    this.pendingSamples += samples;
    if (this.pendingSamples >= this.pageSamples) this.flush();
  }

  /** Writes buffered packets as a page. */
  flush(flags = 0): void {
    if (!this.pending.length && !(flags & PAGE_EOS)) return;
    this.granule += BigInt(this.pendingSamples);
    this.emit(buildOggPage(this.serial, this.sequence++, this.granule, flags, this.pending));
    this.pending = [];
    this.pendingSegments = 0;
    this.pendingSamples = 0;
  }

  /** Flushes with the end-of-stream flag. Pass `atMs` to pad trailing silence up to the stop time. */
  close(atMs?: number): void {
    if (this.closed) return;
    if (atMs !== undefined) this.fillTo(atMs);
    this.flush(PAGE_EOS);
    this.closed = true;
  }

  private emit(page: Buffer): void { this.bytes += page.length; this.sink(page); }
}

// ---- Reading (tests and crash recovery) ----

export interface OggPage { offset: number; length: number; flags: number; granule: bigint; serial: number; sequence: number; packets: Buffer[]; crcValid: boolean }

/**
 * Parses consecutive pages from the start of `data`, stopping at the first truncated or corrupt page.
 * `validLength` is the byte length of the intact prefix.
 */
export function readOggPages(data: Buffer): { pages: OggPage[]; validLength: number } {
  const pages: OggPage[] = [];
  let offset = 0;
  while (offset + 27 <= data.length) {
    if (data.toString('latin1', offset, offset + 4) !== 'OggS' || data[offset + 4] !== 0) break;
    const segments = data[offset + 26]!;
    if (offset + 27 + segments > data.length) break;
    const lacing = data.subarray(offset + 27, offset + 27 + segments);
    const bodyLength = lacing.reduce((sum, value) => sum + value, 0);
    const length = 27 + segments + bodyLength;
    if (offset + length > data.length) break;
    const page = Buffer.from(data.subarray(offset, offset + length));
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    const crcValid = oggCrc32(page) === stored;
    if (!crcValid) break;
    const packets: Buffer[] = [];
    let cursor = 27 + segments;
    let current: Buffer[] = [];
    for (const size of lacing) {
      current.push(data.subarray(offset + cursor, offset + cursor + size));
      cursor += size;
      if (size < 255) { packets.push(Buffer.concat(current)); current = []; }
    }
    pages.push({ offset, length, flags: data[offset + 5]!, granule: data.readBigInt64LE(offset + 6),
      serial: data.readUInt32LE(offset + 14), sequence: data.readUInt32LE(offset + 18), packets, crcValid });
    offset += length;
  }
  return { pages, validLength: offset };
}
