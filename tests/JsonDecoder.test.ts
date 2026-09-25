import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { JsonDecoder, JsonParserStream, toJsonAsyncIterable, toJsonStream } from '../src';
import { bytesToStream, parse } from './utils';

const geojson = fs.readFileSync(new URL('../examples/data/point-samples.geojson', import.meta.url), 'utf8');
const features = JSON.parse(geojson).features;

// Chunk sizes covering single bytes, sizes that split tokens at varying offsets, and one chunk for everything
const CHUNK_SIZES = [1, 2, 3, 5, 7, 13, 64, 1000, 1_000_000];

function stringStream(chunks: string[]): ReadableStream<string> {
    return new ReadableStream<string>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader();
    const items: T[] = [];
    let result: ReadableStreamReadResult<T>;
    while (!(result = await reader.read()).done) items.push(result.value);
    return items;
}

describe('JsonDecoder', () => {

    describe('chunk boundaries', () => {

        it.each(CHUNK_SIZES)('parses a GeoJSON file identically with %i-byte chunks', async (chunkSize) => {
            expect(await parse(geojson, { lookup: '"features"' }, chunkSize)).toEqual(features);
        });

        it.each([1, 2, 3, 4])('decodes multi-byte UTF-8 characters split across %i-byte chunks', async (chunkSize) => {
            const items = [{ s: 'héllo' }, { s: '日本語' }, { s: '🌍🚀' }, { 'ключ': 'значение' }];
            expect(await parse(JSON.stringify(items), undefined, chunkSize)).toEqual(items);
        });

        it('finds a lookup string split at any position across chunks', async () => {
            const json = '{"meta":"x","features":[{"id":1}]}';
            for (let chunkSize = 1; chunkSize <= json.length; chunkSize++)
                expect(await parse(json, { lookup: '"features"' }, chunkSize), `chunk size ${chunkSize}`).toEqual([{ id: 1 }]);
        });

        it('matches JSON.parse on random items with escape-heavy strings at every chunk size', async () => {
            // Seeded PRNG so failures are reproducible
            let seed = 42;
            const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
            const text = () => Array.from({ length: Math.floor(random() * 12) }, () => pick(['\\', '\\\\', '"', '\\"', '{', '}', '[', ']', 'a', 'é', '🌍', '\n'])).join('');
            const value = (depth: number): unknown => {
                const kind = depth > 2 ? pick(['s', 'n']) : pick(['s', 'n', 'o', 'a']);
                if (kind === 's') return text();
                if (kind === 'n') return Math.floor(random() * 1000) / 10;
                if (kind === 'a') return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
                return Object.fromEntries(Array.from({ length: Math.floor(random() * 3) }, () => [text(), value(depth + 1)]));
            };
            const items = Array.from({ length: 40 }, () => ({ [text()]: value(0), s: text() }));
            const json = JSON.stringify(items);
            for (let chunkSize = 1; chunkSize <= 40; chunkSize++)
                expect(await parse(json, undefined, chunkSize), `chunk size ${chunkSize}`).toEqual(items);
        });

        it('parses an item spanning many chunks', async () => {
            const big = { data: 'x'.repeat(1_000_000), nested: { list: Array.from({ length: 1000 }, (_, i) => ({ i, s: `{"${i}"}` })) } };
            const json = `[{"before":1},${JSON.stringify(big)},{"after":2}]`;
            expect(await parse(json, undefined, 64 * 1024)).toEqual([{ before: 1 }, big, { after: 2 }]);
        });

        it('handles escape sequences split at any position across chunks', async () => {
            const items = [{ a: '\\"}' }, { b: 'ends with backslash\\' }, { c: '\\\\{' }];
            const json = JSON.stringify(items);
            for (let chunkSize = 1; chunkSize <= json.length; chunkSize++)
                expect(await parse(json, undefined, chunkSize), `chunk size ${chunkSize}`).toEqual(items);
        });
    });

    describe('strings', () => {

        it('ignores braces and brackets inside strings', async () => {
            const items = [{ a: '}{][', b: '{' }, { c: '}' }];
            expect(await parse(JSON.stringify(items))).toEqual(items);
        });

        it('handles escaped quotes and backslashes', async () => {
            const items = [{ a: '"' }, { b: '\\' }, { c: '\\"}' }, { d: '"{"' }];
            expect(await parse(JSON.stringify(items))).toEqual(items);
        });

        it('handles unicode escapes', async () => {
            expect(await parse('[{"a":"\\u007b\\u0022\\u00e9"}]')).toEqual([{ a: '{"é' }]);
        });
    });

    describe('structure', () => {

        it('keeps nested objects and arrays inside items', async () => {
            const items = [{ a: { b: { c: [1, [2, { d: 3 }]] } } }, { e: [[], {}, [{}]] }];
            expect(await parse(JSON.stringify(items))).toEqual(items);
        });

        it('preserves every JSON value type inside an item', async () => {
            const items = [{ n: -1.5e10, i: 0, t: true, f: false, z: null, s: '', a: [], o: {} }];
            expect(await parse(JSON.stringify(items))).toEqual(items);
        });

        it('parses pretty-printed input', async () => {
            const items = [{ a: 1, b: [1, 2] }, { c: { d: 'x' } }];
            expect(await parse(JSON.stringify(items, null, 4))).toEqual(items);
        });

        it('parses newline-delimited JSON', async () => {
            expect(await parse('{"a":1}\n{"b":2}\r\n{"c":3}\n')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
        });

        it('emits only objects; primitives and arrays between them are skipped', async () => {
            expect(await parse('[1,"two",true,null,[3,4],{"id":1},5]')).toEqual([{ id: 1 }]);
        });

        it.each(CHUNK_SIZES)('ignores braces inside strings between items with %i-byte chunks', async (chunkSize) => {
            expect(await parse('["a{b",{"id":1}]', undefined, chunkSize)).toEqual([{ id: 1 }]);
            const json = JSON.stringify(['x"{', '}', '\\', { id: 1 }, '{"a":1}', 'tail\\"{', { id: 2 }, '"}"']);
            expect(await parse(json, undefined, chunkSize)).toEqual([{ id: 1 }, { id: 2 }]);
        });

        it.each(CHUNK_SIZES)('handles long text between items with %i-byte chunks', async (chunkSize) => {
            const padding = ' '.repeat(40);
            // a long string holding a brace, long whitespace, and a long gap ending the stream without a quote
            const json = `["${'x'.repeat(40)}{",${padding}{"id":1},${padding}{"id":2}${padding}`;
            expect(await parse(json, undefined, chunkSize)).toEqual([{ id: 1 }, { id: 2 }]);
        });

        it('matches JSON.parse on random arrays mixing objects and escape-heavy strings at every chunk size', async () => {
            let seed = 7;
            const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
            const text = () => Array.from({ length: Math.floor(random() * 8) }, () => pick(['\\', '"', '{', '}', '[', ']', 'a', 'é', '\n'])).join('');
            const values = Array.from({ length: 60 }, (_, i) => random() < 0.5 ? text() : { i, s: text() });
            const json = JSON.stringify(values);
            const objects = values.filter(v => typeof v === 'object');
            for (let chunkSize = 1; chunkSize <= 30; chunkSize++)
                expect(await parse(json, undefined, chunkSize), `chunk size ${chunkSize}`).toEqual(objects);
        });

        it('emits a wrapping object as a single item when no lookup is given', async () => {
            expect(await parse(geojson, undefined, 64)).toEqual([JSON.parse(geojson)]);
        });
    });

    // Streams of separate JSON values rather than one document: NDJSON, CLEF logs and server-sent events
    describe('streamed formats', () => {

        const sse = (events: { event?: string, data: unknown }[]) =>
            events.map(e => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data)}\n\n`).join('');

        it.each(CHUNK_SIZES)('parses CLEF log events with %i-byte chunks', async (chunkSize) => {
            const events = [
                { '@t': '2026-09-25T10:00:00.000Z', '@mt': 'Started {App} on {Port}', App: 'api', Port: 8080 },
                { '@t': '2026-09-25T10:00:01.000Z', '@l': 'Error', '@mt': 'Request {Path} failed', Path: '/x', '@x': 'System.Exception: boom\n   at Foo() in C:\\src\\Foo.cs:line 1' },
                { '@t': '2026-09-25T10:00:02.000Z', '@mt': 'Escaped {{braces}} and {@Order}', Order: { id: 1, lines: [{ sku: 'a' }] } },
            ];
            expect(await parse(events.map(e => JSON.stringify(e)).join('\n') + '\n', undefined, chunkSize)).toEqual(events);
        });

        it.each(CHUNK_SIZES)('parses an OpenAI Chat Completions stream with %i-byte chunks', async (chunkSize) => {
            const chunks = [
                { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
                { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi {there}' } }] },
                { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            ];
            const body = sse(chunks.map(data => ({ data }))) + 'data: [DONE]\n\n';
            expect(await parse(body, undefined, chunkSize)).toEqual(chunks);
        });

        it.each(CHUNK_SIZES)('parses an OpenAI Responses API stream with %i-byte chunks', async (chunkSize) => {
            const events = [
                { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
                { type: 'response.output_text.delta', item_id: 'm1', delta: 'Hello' },
                { type: 'response.completed', response: { id: 'r1', status: 'completed' } },
            ];
            expect(await parse(sse(events.map(data => ({ event: data.type, data }))), undefined, chunkSize)).toEqual(events);
        });

        it.each(CHUNK_SIZES)('parses an Anthropic Messages stream with %i-byte chunks', async (chunkSize) => {
            const events = [
                { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } },
                { type: 'ping' },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
                { type: 'message_stop' },
            ];
            expect(await parse(sse(events.map(data => ({ event: data.type, data }))), undefined, chunkSize)).toEqual(events);
        });

        it('ignores SSE comments, id: and retry: fields, and CRLF line endings', async () => {
            const body = ': keep-alive\r\n\r\nid: 1\r\nretry: 3000\r\ndata: {"a":1}\r\n\r\n: keep-alive\r\n\r\nid: 2\r\ndata: {"b":2}\r\n\r\n';
            expect(await parse(body)).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it('ignores a quote in an SSE field outside JSON', async () => {
            expect(await parse('event: "quoted\ndata: {"a":1}\n\n')).toEqual([{ a: 1 }]);
        });

        it.each(CHUNK_SIZES)('ignores quoted braces in SSE fields and comments with %i-byte chunks', async (chunkSize) => {
            const body = 'event: "{x}"\ndata: {"a":1}\n\n: "{ping}"\n\nevent: "open {\ndata: {"b":2}\n\n';
            expect(await parse(body, undefined, chunkSize)).toEqual([{ a: 1 }, { b: 2 }]);
        });
    });

    describe('lookup', () => {

        it.each(CHUNK_SIZES)('skips objects before the lookup string with %i-byte chunks', async (chunkSize) => {
            const json = '{"crs":{"name":"x"},"bbox":{"a":1},"features":[{"id":1},{"id":2}]}';
            expect(await parse(json, { lookup: '"features"' }, chunkSize)).toEqual([{ id: 1 }, { id: 2 }]);
        });

        it('finds a lookup string at the very start of the stream', async () => {
            expect(await parse('PREFIX{"a":1}', { lookup: 'PREFIX' })).toEqual([{ a: 1 }]);
        });

        it.each(CHUNK_SIZES)('emits nothing when the lookup string never appears with %i-byte chunks', async (chunkSize) => {
            expect(await parse('[{"a":1},{"b":2}]', { lookup: '"features"' }, chunkSize)).toEqual([]);
        });

        it.each(CHUNK_SIZES)('stops at an empty target array with %i-byte chunks', async (chunkSize) => {
            const cases: [string, string][] = [
                ['{"features":[],"crs":{"name":"x"}}', '"features"'],
                ['{"features" :\n  [ \n ] ,\n "crs": {"name": "x"}}', '"features"'],
                [JSON.stringify({ type: 'FeatureCollection', features: [], bbox: { a: 1 } }, null, 4), '"features"'],
                ['{"features":[],"crs":{"name":"x"}}', '"features":['],   // lookup already includes the bracket
                ['{"features":[],"crs":{"name":"x"}}', 'features'],       // unquoted lookup: the key's closing quote follows
            ];
            for (const [json, lookup] of cases)
                expect(await parse(json, { lookup }, chunkSize), `${lookup} in ${json}`).toEqual([]);
        });

        it.each(CHUNK_SIZES)('reads the items after a lookup that ends before the opening bracket with %i-byte chunks', async (chunkSize) => {
            const json = '{"features" : [ {"id":1} , {"id":2} ], "crs": {"name":"x"}}';
            expect(await parse(json, { lookup: '"features"' }, chunkSize)).toEqual([{ id: 1 }, { id: 2 }]);
            expect(await parse(json, { lookup: 'features' }, chunkSize)).toEqual([{ id: 1 }, { id: 2 }]);
        });

        it('treats an empty lookup string as no lookup', async () => {
            expect(await parse('[{"a":1}]', { lookup: '' })).toEqual([{ a: 1 }]);
        });
    });

    describe('termination', () => {

        it.each(CHUNK_SIZES)('stops at the closing bracket of the array with %i-byte chunks', async (chunkSize) => {
            const json = '{"features":[{"id":1}],"other":{"id":2}}';
            expect(await parse(json, { lookup: '"features"' }, chunkSize)).toEqual([{ id: 1 }]);
        });

        it.each(CHUNK_SIZES)('stops at a closing bracket preceded by whitespace with %i-byte chunks', async (chunkSize) => {
            expect(await parse('[{"id":1}\n    ]\n{"id":2}', undefined, chunkSize)).toEqual([{ id: 1 }]);
        });

        it('reads to the end of the stream when there is no closing bracket', async () => {
            expect(await parse('{"a":1} {"b":2} {"c":3}')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
        });
    });

    describe('errors', () => {

        it('delivers the items from earlier chunks, then rejects on an invalid item', async () => {
            const items: unknown[] = [];
            const stream = stringStream(['[{"a":1},', '{"b":2},', '{"c":,}]']).pipeThrough(new JsonParserStream());
            const reader = stream.getReader();
            await expect(async () => {
                let result: ReadableStreamReadResult<unknown>;
                while (!(result = await reader.read()).done) items.push(result.value);
            }).rejects.toThrow('JSON parse error');
            expect(items).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it.each(CHUNK_SIZES)('toJsonAsyncIterable delivers every item before an invalid one, then rejects (%i-byte chunks)', async (chunkSize) => {
            const items: unknown[] = [];
            await expect(async () => {
                for await (const item of toJsonAsyncIterable(bytesToStream('[{"a":1},{"b":2},{"c":,}]', chunkSize))) items.push(item);
            }).rejects.toThrow('JSON parse error');
            expect(items).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it.each(CHUNK_SIZES)('toJsonStream delivers every item before an invalid one, then errors (%i-byte chunks)', async (chunkSize) => {
            const items: unknown[] = [];
            const reader = toJsonStream(bytesToStream('[{"a":1},{"b":2},{"c":,}]', chunkSize)).getReader();
            await expect(async () => {
                let result: ReadableStreamReadResult<unknown>;
                while (!(result = await reader.read()).done) items.push(result.value);
            }).rejects.toThrow('JSON parse error');
            expect(items).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it('drops an incomplete item at the end of the stream', async () => {
            expect(await parse('[{"a":1},{"b":')).toEqual([{ a: 1 }]);
        });
    });

    describe('stream classes', () => {

        it('parses a stream of strings via pipeThrough', async () => {
            const stream = stringStream(['[{"a"', ':1},{', '"b":2}]']).pipeThrough(new JsonParserStream());
            expect(await readAll(stream)).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it('reports statistics', async () => {
            const parser = new JsonParserStream({ lookup: '"items"' });
            const chunks = ['{"skip":{"x":1},"items":[', '{"a":1},{"b":2},', '{"c":3}]}'];
            await readAll(stringStream(chunks).pipeThrough(parser));

            expect(parser.getStat()).toEqual({
                chunks: 3,
                length: chunks.join('').length,
                maxChunkSize: Math.max(...chunks.map(c => c.length)),
                items: 3,
                maxBufferLength: expect.any(Number),
            });
            expect(parser.getStat().maxBufferLength).toBeLessThanOrEqual(chunks[1].length + '"items"'.length);
        });

        it('counts but ignores chunks received after the array has closed', async () => {
            // calls the transformer directly: a real TransformStream stops accepting chunks once terminated
            const decoder = new JsonDecoder<unknown>();
            const enqueued: unknown[] = [];
            const controller = { enqueue: (x: unknown) => enqueued.push(x), terminate: () => { }, error: () => { } } as unknown as TransformStreamDefaultController<unknown>;
            decoder.transform('[{"a":1}]', controller);
            decoder.transform('{"b":2}', controller);

            expect(enqueued).toEqual([{ a: 1 }]);
            expect(decoder.getStat()).toMatchObject({ chunks: 2, items: 1 });
        });

        it('works as a transformer for a plain TransformStream', async () => {
            const stream = stringStream(['{"a":1}', '{"b":2}']).pipeThrough(new TransformStream(new JsonDecoder()));
            expect(await readAll(stream)).toEqual([{ a: 1 }, { b: 2 }]);
        });
    });
});
