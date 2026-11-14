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
