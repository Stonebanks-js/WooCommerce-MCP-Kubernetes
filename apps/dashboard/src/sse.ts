// Minimal, spec-shaped Server-Sent Events parser for fetch + ReadableStream (EventSource cannot
// POST). Bytes may arrive split anywhere, including inside a multi-byte UTF-8 sequence or between
// the two newlines that terminate an event, so decoding is streaming and the buffer is only cut on
// complete blank-line boundaries.

export interface SseEvent {
  /** Value of the "event:" field, or "message" when absent (as in the EventSource spec). */
  event: string;
  /** All "data:" lines joined with a newline. */
  data: string;
  id?: string;
}

const BLANK_LINE = /\r\n\r\n|\n\n|\r\r/;

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  let sawField = false;
  for (const rawLine of block.split(/\r\n|\n|\r/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue; // comment / keep-alive
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    // "retry" and unknown fields are ignored.
  }
  if (!sawField) return null;
  const parsed: SseEvent = { event, data: data.join('\n') };
  if (id !== undefined) parsed.id = id;
  return parsed;
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  /** Feed a chunk of bytes (or already-decoded text) and get every event completed by it. */
  feed(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    for (;;) {
      const match = BLANK_LINE.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Call at end of stream: a final event without a trailing blank line is still dispatched. */
  flush(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const rest = this.buffer;
    this.buffer = '';
    const parsed = rest.trim() === '' ? null : parseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

/** Async iteration over the events of a streaming response body. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const parser = new SseParser();
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(value)) yield ev;
    }
    for (const ev of parser.flush()) yield ev;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
