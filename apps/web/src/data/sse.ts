// Incremental parser for the text/event-stream format (WHATWG HTML, "Parsing an event stream").
// Feed it decoded text in arbitrary chunks; it handles LF, CRLF and CR line endings split across
// chunks, comment lines, multi-line data, and a leading byte-order mark.

/** One dispatched server-sent message. `id` is the `id:` field seen in this message, if any. */
export interface SseMessage {
  event: string;
  data: string;
  id: string | undefined;
}

export interface SseParserHandlers {
  onMessage(message: SseMessage): void;
  /** Comment lines (`: ping`), without the leading colon. */
  onComment?(comment: string): void;
  /** A valid `retry:` field, in milliseconds. */
  onRetry?(ms: number): void;
}

/** Stateful SSE parser; create one per connection. */
export class SseParser {
  private buffer = '';
  private pendingCr = false;
  private started = false;
  private eventType = '';
  private dataLines: string[] = [];
  private hasData = false;
  private messageId: string | undefined;
  /** The last event ID buffer, which per spec persists across messages. */
  lastEventId = '';

  constructor(private readonly handlers: SseParserHandlers) {}

  /** Feeds the next chunk of decoded text. */
  feed(chunk: string): void {
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text.charCodeAt(index);
      if (this.pendingCr) {
        this.pendingCr = false;
        if (char === 0x0a) { start = index + 1; continue; }   // the LF of a CRLF split across chunks
      }
      if (char === 0x0a || char === 0x0d) {
        this.line(this.buffer + text.slice(start, index));
        this.buffer = '';
        if (char === 0x0d) {
          if (index + 1 < text.length) {
            if (text.charCodeAt(index + 1) === 0x0a) index += 1;
          } else {
            this.pendingCr = true;
          }
        }
        start = index + 1;
      }
    }
    this.buffer += text.slice(start);
  }

  /** Discards any incomplete message, as the spec requires at end of stream. */
  reset(): void {
    this.buffer = '';
    this.pendingCr = false;
    this.clearMessage();
  }

  private clearMessage(): void {
    this.eventType = '';
    this.dataLines = [];
    this.hasData = false;
    this.messageId = undefined;
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.charCodeAt(0) === 0x3a) {   // ':' comment
      this.handlers.onComment?.(line.slice(1).replace(/^ /, ''));
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value;
          this.messageId = value;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value));
        break;
      default:
        break;   // unknown fields are ignored
    }
  }

  private dispatch(): void {
    if (!this.hasData) {
      this.clearMessage();
      return;
    }
    const message: SseMessage = {
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
      id: this.messageId
    };
    this.clearMessage();
    this.handlers.onMessage(message);
  }
}
