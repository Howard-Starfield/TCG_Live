import { describe, expect, it } from 'vitest';
import { SseParser, type SseMessage } from './sse';

function collect() {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = new SseParser({
    onMessage: message => messages.push(message),
    onComment: comment => comments.push(comment),
    onRetry: ms => retries.push(ms)
  });
  return { parser, messages, comments, retries };
}

const wire = 'event: change\nid: boot.evt.3.1\ndata: {"type":"change","n":1}\n\n: ping\n\nevent: heartbeat\ndata: {"type":"heartbeat"}\n\n';

describe('SseParser', () => {
  it('parses events, ids, comments and data', () => {
    const { parser, messages, comments } = collect();
    parser.feed(wire);
    expect(messages).toEqual([
      { event: 'change', id: 'boot.evt.3.1', data: '{"type":"change","n":1}' },
      { event: 'heartbeat', id: undefined, data: '{"type":"heartbeat"}' }
    ]);
    expect(comments).toEqual(['ping']);
    expect(parser.lastEventId).toBe('boot.evt.3.1');
  });

  it('gives the same result for every possible chunk boundary', () => {
    const { parser: whole, messages: expected } = collect();
    whole.feed(wire);
    for (let split = 0; split <= wire.length; split += 1) {
      for (let second = split; second <= wire.length; second += 7) {
        const { parser, messages } = collect();
        parser.feed(wire.slice(0, split));
        parser.feed(wire.slice(split, second));
        parser.feed(wire.slice(second));
        expect(messages).toEqual(expected);
      }
    }
  });

  it('feeds byte-by-byte', () => {
    const { parser, messages } = collect();
    for (const char of wire) parser.feed(char);
    expect(messages).toHaveLength(2);
  });

  it('handles CRLF and CR line endings, including a CRLF split across chunks', () => {
    const crlf = wire.replace(/\n/g, '\r\n');
    const cr = wire.replace(/\n/g, '\r');
    for (const text of [crlf, cr]) {
      const { parser, messages } = collect();
      parser.feed(text);
      expect(messages.map(message => message.data)).toEqual(['{"type":"change","n":1}', '{"type":"heartbeat"}']);
    }
    const { parser, messages } = collect();
    parser.feed('data: a\r');
    parser.feed('\ndata: b\r');
    parser.feed('\n\r');
    parser.feed('\n');
    expect(messages).toEqual([{ event: 'message', id: undefined, data: 'a\nb' }]);
  });

  it('joins multi-line data, strips one leading space, and ignores unknown fields', () => {
    const { parser, messages, retries } = collect();
    parser.feed('data:first\ndata:  second\nfoo: bar\nretry: 2500\nretry: x\ndata\n\n');
    expect(messages).toEqual([{ event: 'message', id: undefined, data: 'first\n second\n' }]);
    expect(retries).toEqual([2500]);
  });

  it('does not dispatch blocks without data, and strips a leading BOM', () => {
    const { parser, messages } = collect();
    parser.feed('﻿event: hello\n\nid: 7\n\ndata: x\n\n');
    expect(messages).toEqual([{ event: 'message', id: undefined, data: 'x' }]);
    expect(parser.lastEventId).toBe('7');
  });

  it('discards an unterminated message on reset', () => {
    const { parser, messages } = collect();
    parser.feed('data: partial');
    parser.reset();
    parser.feed('data: next\n\n');
    expect(messages).toEqual([{ event: 'message', id: undefined, data: 'next' }]);
  });
});
