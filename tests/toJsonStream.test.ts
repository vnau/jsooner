import { describe, it, expect } from 'vitest';
import { toJsonAsyncIterable, toJsonStream } from '../src';
import { createMockResponse, stringToStream, waitFor } from './utils';

describe('toJsonStream', () => {
  it('should handle ReadableStream<Uint8Array> input and parse JSON objects', async () => {
    const jsonString = '{"key": "value"}';
    const stream = stringToStream(jsonString);

    // Call toJsonStream with the stream
    const parsedStream = toJsonStream<{ key: string }>(stream);

    const reader = parsedStream.getReader();
    const result: Array<{ key: string }> = [];

    // Read and parse the stream
    const { value, done } = await reader.read();
    if (!done) result.push(value);

    expect(result).toEqual([{ key: 'value' }]);
  });

  it('should handle Response input and parse JSON objects', async () => {
    const jsonString = '{"key": "value"}';
    const stream = stringToStream(jsonString);
    const response = createMockResponse(stream);

    // Call toJsonStream with the response
    const parsedStream = toJsonStream<{ key: string }>(response);

    const reader = parsedStream.getReader();
    const result: Array<{ key: string }> = [];

    // Read and parse the stream
    const { value, done } = await reader.read();
    if (!done) result.push(value);

    expect(result).toEqual([{ key: 'value' }]);
  });

  it('should throw an error if no readable stream is found', async () => {
    // Call toJsonStream with invalid input
    await expect(() => toJsonStream(null as unknown as Response)).toThrowError('No readable stream found.');
  });

  it('should throw an error for a Response without a body', () => {
    expect(() => toJsonStream(new Response(null))).toThrowError('No readable stream found.');
  });

  it('should pass the lookup config to the parser', async () => {
    const stream = toJsonStream(stringToStream('{"meta":"x","items":[{"a":1}]}', 4), { lookup: '"items"' });
    const reader = stream.getReader();
    const result: unknown[] = [];
    let chunk: ReadableStreamReadResult<unknown>;
    while (!(chunk = await reader.read()).done) result.push(chunk.value);

    expect(result).toEqual([{ a: 1 }]);
  });

  it('should parse multiple JSON objects from the stream', async () => {
    const jsonString = '[{"key1": "value1"},{"key2": "value2"}] ';
    const stream = stringToStream(jsonString);

    // Call toJsonStream with the stream
    const parsedStream = toJsonStream<{ key1?: string; key2?: string }>(stream);

    const reader = parsedStream.getReader();
    const result: any[] = [];

    // Read and parse the stream
    let { value, done } = await reader.read();
    while (!done) {
      result.push(value);
      ({ value, done } = await reader.read());
    }

    expect(result).toEqual([{ key1: 'value1' }, { key2: 'value2' }]);
  });

  it('non-completed JSON objects should not be returned', async () => {
    const jsonString = '{"key1": "value1"}{"key2": "value2"';
    const stream = stringToStream(jsonString, 1);

    // Call toJsonStream with the stream
    const parsedStream = toJsonStream<any>(stream);
    const reader = parsedStream.getReader();
    const result: any[] = [];

    // Read and parse the stream
    let { value, done } = await reader.read();
    while (!done) {
      result.push(value);
      ({ value, done } = await reader.read());
    }

    expect(result).toEqual([{ key1: 'value1' }]);
  });

  it('should not touch the global Response for a plain stream', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Response')!;
    let reads = 0;
    Object.defineProperty(globalThis, 'Response', { configurable: true, get() { reads++; return descriptor.value ?? descriptor.get?.call(globalThis); } });
    try {
      const reader = toJsonStream(stringToStream('{"a":1}', 100)).getReader();
      expect((await reader.read()).value).toEqual({ a: 1 });
      for await (const _ of toJsonAsyncIterable(stringToStream('{"a":1}', 100)));
    } finally {
      Object.defineProperty(globalThis, 'Response', descriptor);
    }
    expect(reads).toBe(0);
  });

  it('should pass cancel() through to the source', async () => {
    let reason: unknown;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('{"a":1},')); },
      cancel(r) { reason = r; },
    });
    const reader = toJsonStream(source).getReader();
    await reader.read();
    await reader.cancel('stop');

    await waitFor(() => reason !== undefined);
    expect(reason).toBe('stop');
  });

});
