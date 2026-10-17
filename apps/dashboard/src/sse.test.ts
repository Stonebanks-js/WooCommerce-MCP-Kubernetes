import { describe, expect, it } from 'vitest';
import { readSseStream, SseParser } from './sse.js';

const STREAM = [
  'event: start\ndata: {"model":"m","provider":"p","toolCount":3}\n\n',
  'event: text\ndata: {"delta":"héllo "}\n\n',
  ': keep-alive comment\n\n',
  'event: tool_call\ndata: {"id":"c1","publicName":"woo__list_orders","serverSlug":"woo","toolName":"list_orders","args":{"status":"processing"}}\n\n',
  'event: text\r\ndata: {"delta":"wörld"}\r\n\r\n',
  'data: first line\ndata: second line\n\n',
  'event: done\ndata: {"message":"ok","toolCalls":[]}\n\n',
].join('');

const EXPECTED = [
  { event: 'start', data: '{"model":"m","provider":"p","toolCount":3}' },
  { event: 'text', data: '{"delta":"héllo "}' },
  { event: 'tool_call', data: '{"id":"c1","publicName":"woo__list_orders","serverSlug":"woo","toolName":"list_orders","args":{"status":"processing"}}' },
  { event: 'text', data: '{"delta":"wörld"}' },
  { event: 'message', data: 'first line\nsecond line' },
  { event: 'done', data: '{"message":"ok","toolCalls":[]}' },
];

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

describe('SseParser', () => {
  const bytes = new TextEncoder().encode(STREAM);

  it('parses a whole multi-event chunk at once', () => {
    const parser = new SseParser();
    expect([...parser.feed(bytes), ...parser.flush()]).toEqual(EXPECTED);
  });

  it.each([1, 2, 3, 5, 7, 11, 64, 1000])('parses identical events when bytes arrive %i at a time', (size) => {
    const parser = new SseParser();
    const events = chunksOf(bytes, size).flatMap((chunk) => parser.feed(chunk));
    events.push(...parser.flush());
    expect(events).toEqual(EXPECTED);
  });

  it('keeps multi-byte characters intact across chunk boundaries', () => {
    const parser = new SseParser();
    const encoded = new TextEncoder().encode('event: text\ndata: {"delta":"日本語"}\n\n');
    // 日 is 3 bytes; cut right in the middle of it.
    const cut = encoded.indexOf(0xe6) + 1;
    const events = [...parser.feed(encoded.slice(0, cut)), ...parser.feed(encoded.slice(cut))];
    expect(events).toEqual([{ event: 'text', data: '{"delta":"日本語"}' }]);
  });

  it('dispatches a trailing event that has no final blank line on flush', () => {
    const parser = new SseParser();
    expect(parser.feed('event: error\ndata: {"message":"boom"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'error', data: '{"message":"boom"}' }]);
  });

  it('ignores retry, unknown fields and comment-only blocks, and keeps ids', () => {
    const parser = new SseParser();
    const events = parser.feed('retry: 3000\nfoo: bar\nid: 7\nevent: text\ndata: x\n\n: ping\n\n');
    expect(events).toEqual([{ event: 'text', data: 'x', id: '7' }]);
  });
});

describe('readSseStream', () => {
  it('yields events from a ReadableStream split at arbitrary boundaries', async () => {
    const bytes = new TextEncoder().encode(STREAM);
    const chunks = chunksOf(bytes, 13);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const events = [];
    for await (const ev of readSseStream(body)) events.push(ev);
    expect(events).toEqual(EXPECTED);
  });
});
