// File-type sniffing from a file's first bytes. The client's declared type is never trusted.
import type { EvidenceFileExtension } from '@tcg-live/core';

/** Bytes kept from the start of a stream for sniffing. */
export const SNIFF_BYTES = 4096;

const ascii = (head: Uint8Array, start: number, length: number) =>
  head.length >= start + length ? Buffer.from(head.subarray(start, start + length)).toString('latin1') : '';

function indexOfAscii(head: Uint8Array, text: string): number {
  return Buffer.from(head).indexOf(Buffer.from(text, 'latin1'));
}

/**
 * MP4/MOV/M4A (ISO BMFF `ftyp`), WebM/MKV (EBML DocType), Ogg and MP3 (ID3 tag or MPEG audio frame sync).
 * Returns null for anything else, including ADTS AAC and empty input.
 */
export function sniffEvidenceType(head: Uint8Array): EvidenceFileExtension | null {
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'qt  ') return 'mov';
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    return brand.length === 4 ? 'mp4' : null;
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const webm = indexOfAscii(head, 'webm');
    const matroska = indexOfAscii(head, 'matroska');
    if (webm !== -1 && (matroska === -1 || webm < matroska)) return 'webm';
    return 'mkv';
  }
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame: 11 sync bits, a valid version, and layer bits != 00 (00 is ADTS AAC, not MP3).
  if (head.length >= 4 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x18) !== 0x08 &&
      (head[1]! & 0x06) !== 0 && (head[2]! & 0xf0) !== 0xf0) return 'mp3';
  return null;
}

/**
 * ISO BMFF sample-entry codes that browsers generally cannot decode: HEVC (hvc1/hev1, Dolby Vision
 * dvh1/dvhe) and Apple ProRes. Files with one of these are stored as download-only.
 */
export const DOWNLOAD_ONLY_CODECS: ReadonlySet<string> = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe',
  'apcn', 'apch', 'apcs', 'apco', 'ap4h', 'ap4x']);
/** A `moov` box larger than this is not read for codec sniffing (the file stays playable). */
export const MAX_MOOV_SNIFF_BYTES = 32 * 1024 * 1024;

/** Reads `length` bytes at `position`; fewer at the end of the file. */
export type ReadAt = (position: number, length: number) => Promise<Buffer>;

/** Sample-entry codes in every `stsd` box of a `moov` payload. */
export function stsdCodecs(moov: Buffer): string[] {
  const codecs: string[] = [];
  let from = 0;
  for (;;) {
    const at = moov.indexOf('stsd', from, 'latin1');
    if (at < 4) { if (at === -1) break; from = at + 4; continue; }
    from = at + 4;
    // stsd: size(4) 'stsd' version+flags(4) entry_count(4), then entries of size(4) type(4) ...
    const boxStart = at - 4;
    const boxSize = moov.readUInt32BE(boxStart);
    const boxEnd = Math.min(moov.length, boxStart + boxSize);
    if (boxSize < 16 || at + 12 > boxEnd) continue;
    const count = moov.readUInt32BE(at + 8);
    let entry = at + 12;
    for (let i = 0; i < count && i < 16 && entry + 8 <= boxEnd; i++) {
      const size = moov.readUInt32BE(entry);
      codecs.push(moov.toString('latin1', entry + 4, entry + 8));
      if (size < 8) break;
      entry += size;
    }
  }
  return codecs;
}

/**
 * The sample-entry codes of an MP4/MOV file, found by walking top-level boxes to `moov` (which may be at
 * the end of the file). Null when the layout cannot be read or `moov` is too large to sniff.
 */
export async function mp4Codecs(readAt: ReadAt, fileSize: number): Promise<string[] | null> {
  let position = 0;
  for (let boxes = 0; position + 8 <= fileSize && boxes < 10_000; boxes++) {
    const header = await readAt(position, 16);
    if (header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) size = fileSize - position;
    if (size < headerSize) return null;
    if (type === 'moov') {
      const length = Math.min(size, fileSize - position) - headerSize;
      if (length > MAX_MOOV_SNIFF_BYTES) return null;
      return stsdCodecs(await readAt(position + headerSize, length));
    }
    position += size;
  }
  return null;
}

/** True when an MP4/MOV holds a codec from DOWNLOAD_ONLY_CODECS. */
export async function isDownloadOnlyMp4(readAt: ReadAt, fileSize: number): Promise<boolean> {
  const codecs = await mp4Codecs(readAt, fileSize).catch(() => null);
  return codecs?.some(codec => DOWNLOAD_ONLY_CODECS.has(codec)) ?? false;
}
