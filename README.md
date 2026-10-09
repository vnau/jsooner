# jsooner

[![npm](https://img.shields.io/npm/v/jsooner?color=brightgreen&logo=npm)](https://www.npmjs.com/package/jsooner)
[![downloads](https://img.shields.io/npm/dm/jsooner)](https://www.npmjs.com/package/jsooner)
![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/vnau/7353726794cee33914eb47e39e6694c6/raw/jsooner__heads_main.json)
[![bundle size](https://deno.bundlejs.com/badge?q=jsooner)](https://bundlejs.com/?q=jsooner)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/npm/l/jsooner)](LICENSE)

`jsooner` is a small, dependency-free library that reads JSON objects one at a time from a byte stream, such as a `fetch` response.

It is built for long sequences of objects: the items of a large array like GeoJSON `features`, newline-delimited logs, or the events of an LLM streaming response. It is deliberately not a full JSON parser.

## Why jsooner?

`JSON.parse` needs the whole document in memory, both the text and the resulting objects, and gives you nothing until the download has finished. `jsooner` instead:

- **Hands out each object as soon as it has arrived,** so you can process the first items while the rest is still downloading.
- **Keeps memory flat, whatever the input size.** On a 136 MB GeoJSON file it peaked at 61 MB, against 503 MB for `JSON.parse` (see [Performance](#performance)).
- **Stays close to `JSON.parse` in speed.** It only finds where each object starts and ends, then parses that object with the native `JSON.parse`.
- **Reads streamed formats directly:** NDJSON, CLEF logs and server-sent events from LLM APIs, with no separate parser in front.

## Performance

`jsooner` has been benchmarked against other JavaScript JSON parsers that can stream items, as well as the native `JSON.parse` method. The input is a generated 136 MB GeoJSON file with 360,000 features, read in 64 KB chunks, with each parser in its own process.

![Parsing time vs peak memory](assets/benchmark.svg)

Lower left is better. `JSON.parse` is faster, but it holds the whole document in memory: 503 MB here. json-ext's `parseChunked` is about as fast as `jsooner` but also builds the whole document (400 MB). Of the parsers that stream items one at a time, `jsooner` is the fastest and uses the least memory. To reproduce, run `pnpm bench` (see [bench/README.md](bench/README.md)).

## Installation

```bash
npm install jsooner
```

`jsooner` uses only web-standard APIs (`ReadableStream`, `TextDecoder`), so it runs in modern browsers and in Node.js. It is tested on Node.js 24.

## Usage

### Items of a large array

Pass the text that comes right before the array as `lookup`. Everything up to and including it is skipped, and the objects inside the array are returned one by one:

```ts
import { toJsonAsyncIterable } from "jsooner";

interface Feature { properties: { name: string } }

const response = await fetch("https://raw.githubusercontent.com/vnau/jsooner/refs/heads/main/examples/data/point-samples.geojson");
for await (const feature of toJsonAsyncIterable<Feature>(response, { lookup: '"features"' })) {
    console.log(feature.properties.name);
}
```

Reading stops at the array's closing `]`, and the rest of the download is cancelled. The type parameter describes the objects; without it they are `unknown`.

### Newline-delimited JSON and logs

Without `lookup`, every top-level object in the stream is returned. That covers NDJSON / JSON Lines, objects written one after another, and CLEF logs from Serilog or Seq:

```ts
for await (const event of toJsonAsyncIterable<{ "@t": string; "@mt": string }>(response)) {
    console.log(event["@t"], event["@mt"]);
}
```

### LLM streaming responses

Server-sent event streams, such as those from the OpenAI and Anthropic APIs, can be read straight from `fetch`. The `data:` prefixes, `event:` lines, comments and OpenAI's closing `data: [DONE]` are skipped, and each event's JSON object is returned:

```ts
const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true }),
});
for await (const chunk of toJsonAsyncIterable<{ choices: { delta: { content?: string } }[] }>(response)) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Stopping early

Leaving the loop with `break`, `return` or an exception cancels the source, so a `fetch` download is aborted:

```ts
for await (const feature of toJsonAsyncIterable<Feature>(response, { lookup: '"features"' })) {
    if (feature.properties.name === "La Baie") break;   // the rest is not downloaded
}
```

### As a stream

`toJsonStream` returns the same objects as a `ReadableStream`, for piping or backpressure-aware consumers. Calling `cancel()` on it cancels the source.

```ts
import { toJsonStream } from "jsooner";

await toJsonStream<Feature>(response, { lookup: '"features"' }).pipeTo(new WritableStream<Feature>({
    write(feature) { console.log(feature.properties.name); },
}));
```

## API

| Function | Returns |
|---|---|
| `toJsonAsyncIterable<T>(source, options?)` | `AsyncIterable<T>` |
| `toJsonStream<T>(source, options?)` | `ReadableStream<T>` |

- **`source`:** a `Response` or a `ReadableStream<Uint8Array>` of UTF-8 bytes. Both functions throw `No readable stream found.` if a `Response` has no body.
- **`options.lookup`:** text to skip to before reading objects (see [Limitations](#limitations)).
- **Errors:** invalid JSON inside an object rejects the iteration or errors the stream with a `JSON parse error: …` message, after the objects before it have been delivered.

`JsonParserStream` is also exported: a `TransformStream<string, T>` for pipelines that already decode text themselves.

## Limitations

`jsooner` trades completeness for speed, so it is meant for well-formed input from a source you trust:

- **Only objects are returned.** Numbers, strings, booleans and arrays at the top level of the array or stream are skipped.
- **`lookup` is a plain text search.** It stops at the first occurrence of the text, even if that is inside a string value or a nested object. Pick text that appears only where the array starts, such as `'"features"'` in GeoJSON.
- **Text outside objects is not validated.** A stream that ends in the middle of an object ends without an error, so a truncated download looks complete.
- **Server-sent events:** a value split over several `data:` lines, or an unquoted `{` in an SSE comment, is not supported.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
