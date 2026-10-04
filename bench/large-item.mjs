// Measures parsing a single large object that spans many chunks.
// Confirms the decoder stays linear (each byte scanned once), compared with native `JSON.parse`.
// Usage: node bench/large-item.mjs [sizesMb=2,8,32]   (requires `pnpm build`)
import { toJsonAsyncIterable } from "../dist/index.js";

const CHUNK_SIZE = 64 * 1024;
const sizes = (process.argv[2] ?? "2,8,32").split(",").map(Number);
const encoder = new TextEncoder();

function byteStream(text) {
    const bytes = encoder.encode(text);
    return new ReadableStream({
        start(controller) {
            for (let i = 0; i < bytes.length; i += CHUNK_SIZE) controller.enqueue(bytes.subarray(i, i + CHUNK_SIZE));
            controller.close();
        },
    });
}

async function time(fn) {
    const start = performance.now();
    await fn();
    return `${(performance.now() - start).toFixed(0)} ms`;
}

console.log(`Single object, ${CHUNK_SIZE / 1024} KB chunks, Node ${process.version}\n`);
console.log("| Object size | jsooner | JSON.parse |");
console.log("|---:|---:|---:|");
for (const mb of sizes) {
    const json = '[{"data":"' + "x".repeat(mb * 1024 * 1024) + '"}]';
    const jsooner = await time(async () => { for await (const _ of toJsonAsyncIterable(byteStream(json))); });
    const native = await time(() => JSON.parse(json));
    console.log(`| ${mb} MB | ${jsooner} | ${native} |`);
}
