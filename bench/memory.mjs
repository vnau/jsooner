// Breaks down jsooner's peak memory: runtime baseline, stream plumbing, chunk size and GC settings.
// Each scenario runs in its own process so peak RSS is clean.
// Usage: node bench/memory.mjs [file=bench/data/big.geojson]   (requires `pnpm build`)
import fs from "node:fs";
import v8 from "node:v8";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SMALL = 64 * 1024;
const LARGE = 1024 * 1024;

// name, worker mode, chunk size, extra node flags
const SCENARIOS = [
    ["Empty `node` process", "empty", SMALL, []],
    ["Stream the file through `TextDecoderStream`, no parsing", "decode", SMALL, []],
    ["Stream the raw file bytes, no decoding or parsing", "read", SMALL, []],
    ["jsooner", "jsooner", SMALL, []],
    ["jsooner with `--max-semi-space-size=1`", "jsooner", SMALL, ["--max-semi-space-size=1"]],
    ["jsooner with 1 MB chunks", "jsooner", LARGE, []],
];

async function worker(mode, file, chunkSize) {
    const web = () => Readable.toWeb(fs.createReadStream(file, { highWaterMark: chunkSize }));
    let maxHeap = 0;
    const sample = () => { maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed); };
    const timer = setInterval(sample, 5);
    if (mode === "read") for await (const _ of web());
    if (mode === "decode") for await (const _ of web().pipeThrough(new TextDecoderStream()));
    if (mode === "jsooner") {
        const { toJsonAsyncIterable } = await import("../dist/index.js");
        for await (const _ of toJsonAsyncIterable(web(), { lookup: '"features"' }));
    }
    clearInterval(timer);
    sample();
    const newSpace = v8.getHeapSpaceStatistics().find(s => s.space_name === "new_space");
    console.log(JSON.stringify({
        rssMb: process.resourceUsage().maxRSS / 1024,
        heapMb: maxHeap / 1048576,
        semiSpaceMb: newSpace.space_size / 1048576,
    }));
}

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--worker") {
    const [, , , mode, file, chunkSize] = process.argv;
    if (mode === "empty") console.log(JSON.stringify({ rssMb: process.resourceUsage().maxRSS / 1024 }));
    else await worker(mode, file, Number(chunkSize));
} else {
    const file = process.argv[2] ?? "bench/data/big.geojson";
    console.log(`${file}, ${(fs.statSync(file).size / 1e6).toFixed(0)} MB, Node ${process.version}, ${process.platform}\n`);
    console.log("| Scenario | Peak RSS, MB | Peak heap used, MB | Young-generation semi-space, MB |");
    console.log("|---|---:|---:|---:|");
    for (const [name, mode, chunkSize, flags] of SCENARIOS) {
        const r = JSON.parse(execFileSync(process.execPath, [...flags, self, "--worker", mode, file, String(chunkSize)], { encoding: "utf8" }));
        const cell = v => v === undefined ? "" : v.toFixed(0);
        console.log(`| ${name} | ${cell(r.rssMb)} | ${cell(r.heapMb)} | ${cell(r.semiSpaceMb)} |`);
    }
}
