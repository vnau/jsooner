// Splits jsooner's parsing time into stages and compares it with json-ext parseChunked and JSON.parse.
// Every row is the best of 3 warm runs in this process.
// Usage: node bench/time-breakdown.mjs [file=bench/data/big.geojson]   (requires `pnpm build`)
import fs from "node:fs";
import { Readable } from "node:stream";
import { parseChunked } from "@discoveryjs/json-ext";
import { JsonDecoder, toJsonAsyncIterable } from "../dist/index.js";

const file = process.argv[2] ?? "bench/data/big.geojson";
const CHUNK_SIZE = 64 * 1024;
const RUNS = 3;

async function time(label, fn) {
    await fn(); // warm-up
    let best = Infinity;
    for (let i = 0; i < RUNS; i++) {
        const start = performance.now();
        await fn();
        best = Math.min(best, performance.now() - start);
    }
    console.log(`| ${label} | ${(best / 1000).toFixed(2)} |`);
}

// A TransformStreamDefaultController stand-in that only counts items
const countingController = () => {
    const controller = { count: 0, enqueue() { this.count++; }, terminate() { }, error(e) { throw new Error(e); } };
    return controller;
};
const nodeStream = () => fs.createReadStream(file, { highWaterMark: CHUNK_SIZE });

console.log(`${file}, ${(fs.statSync(file).size / 1e6).toFixed(0)} MB, Node ${process.version}, ${process.platform}, best of ${RUNS} warm runs\n`);

console.log("Reading from disk:\n");
console.log("| Path | Time, s |");
console.log("|---|---:|");
await time('`JSON.parse(fs.readFileSync(file, "utf8"))`', () => JSON.parse(fs.readFileSync(file, "utf8")));
await time("jsooner `JsonDecoder`, fed directly from a Node file stream with `TextDecoder`, no web streams", async () => {
    const decoder = new TextDecoder(), parser = new JsonDecoder({ lookup: '"features"' }), controller = countingController();
    for await (const chunk of nodeStream()) parser.transform(decoder.decode(chunk, { stream: true }), controller);
});
await time("json-ext `parseChunked(fs.createReadStream(file))`", () => parseChunked(nodeStream()));
await time("jsooner `toJsonAsyncIterable(Readable.toWeb(fs.createReadStream(file)))`, the public API", async () => {
    for await (const _ of toJsonAsyncIterable(Readable.toWeb(nodeStream()), { lookup: '"features"' }));
});
await time("the same, from a web-native stream (`fs.openAsBlob(file).stream()`)", async () => {
    for await (const _ of toJsonAsyncIterable((await fs.openAsBlob(file)).stream(), { lookup: '"features"' }));
});
await time("Read only: Node file stream", async () => { for await (const _ of nodeStream()); });
await time("Read only: `Readable.toWeb`", async () => { const r = Readable.toWeb(nodeStream()).getReader(); while (!(await r.read()).done); });
await time("Read only: `Readable.toWeb` + `TextDecoderStream`", async () => {
    const r = Readable.toWeb(nodeStream()).pipeThrough(new TextDecoderStream()).getReader();
    while (!(await r.read()).done);
});

// In-memory stages: the target array's text, split into 64 KB string chunks, and the individual item strings
const text = fs.readFileSync(file, "utf8");
const body = text.slice(text.indexOf("[", text.indexOf('"features"')));
const chunks = [];
for (let i = 0; i < body.length; i += CHUNK_SIZE) chunks.push(body.slice(i, i + CHUNK_SIZE));
const items = [];
{
    const parse = JSON.parse;
    JSON.parse = s => { items.push(s); return 0; };   // capture item strings instead of parsing
    const decoder = new JsonDecoder(), controller = countingController();
    for (const chunk of chunks) decoder.transform(chunk, controller);
    JSON.parse = parse;
}
const perChunk = Math.round(items.length / chunks.length);
const batches = [];
for (let i = 0; i < items.length; i += perChunk) batches.push("[" + items.slice(i, i + perChunk).join(",") + "]");

console.log(`\nIn memory (${items.length.toLocaleString("en-US")} items, ${chunks.length.toLocaleString("en-US")} chunks):\n`);
console.log("| Stage | Time, s |");
console.log("|---|---:|");
await time(`\`JSON.parse\` of the ${items.length.toLocaleString("en-US")} items, one call each`, () => { for (const item of items) JSON.parse(item); });
await time(`\`JSON.parse\` of the same items in batches of ${perChunk} (${batches.length.toLocaleString("en-US")} calls, as json-ext does per 64 KB chunk)`, () => { for (const batch of batches) JSON.parse(batch); });
await time("jsooner 1.5.0 brace-counting scan over the items (`input[i]`)", () => {
    for (const item of items) {
        let balance = 0, inString = false;
        for (let i = 0; i < item.length; i++) {
            const c = item[i];
            if (inString) { if (c === "\\") { i++; continue; } if (c === '"') inString = false; }
            else if (c === '"') inString = true;
            else { if (c === "{") balance++; else if (c === "}") balance--; if (balance === 0) break; }
        }
    }
});
await time("jsooner `JsonDecoder` single pass over the chunks, `JSON.parse` stubbed out", () => {
    const parse = JSON.parse;
    JSON.parse = () => 0;
    const decoder = new JsonDecoder(), controller = countingController();
    for (const chunk of chunks) decoder.transform(chunk, controller);
    JSON.parse = parse;
});
await time("jsooner `JsonDecoder` including `JSON.parse` of each item", () => {
    const decoder = new JsonDecoder(), controller = countingController();
    for (const chunk of chunks) decoder.transform(chunk, controller);
});
await time(`${items.length.toLocaleString("en-US")} \`enqueue()\` + \`read()\` through a \`TransformStream\`, no parsing`, async () => {
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < chunks.length; i++) c.enqueue(i); c.close(); } })
        .pipeThrough(new TransformStream({ transform(_, c) { for (let k = 0; k < perChunk; k++) c.enqueue(k); } }));
    const reader = stream.getReader();
    while (!(await reader.read()).done);
});
