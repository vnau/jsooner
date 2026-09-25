import { JsonParserConfig, toJsonAsyncIterable } from '../src';

// Mock for Response body with a readable stream
export function createMockResponse(body: ReadableStream<Uint8Array>): Response {
    return new Response(body);
}

// Helper function to convert a string to a ReadableStream
// Splits by UTF-16 code units, so it can break surrogate pairs; use bytesToStream for non-ASCII input
export function stringToStream(str: string, chunkSize: number = 1): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (var i = 0; i < str.length;) {
                const next = Math.min(str.length, i + chunkSize);
                controller.enqueue(encoder.encode(str.substring(i, next)));
                i = next;
            }
            controller.close();
        },
    });
}

// Converts a string to a ReadableStream of UTF-8 bytes split every chunkSize bytes,
// so multi-byte characters can be cut in the middle like on a real network stream
export function bytesToStream(str: string, chunkSize: number = 1): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(str);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize)
                controller.enqueue(bytes.slice(i, i + chunkSize));
            controller.close();
        },
    });
}

// Resolves once condition() is true; cancellation travels through piped streams asynchronously
export async function waitFor(condition: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

// Collects every item of an async iterable into an array
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of iterable) items.push(item);
    return items;
}

// Parses a whole string with toJsonAsyncIterable, feeding it in byte chunks of chunkSize
export function parse<T = any>(str: string, config?: JsonParserConfig, chunkSize: number = 1): Promise<T[]> {
    return collect(toJsonAsyncIterable<T>(bytesToStream(str, chunkSize), config));
}
