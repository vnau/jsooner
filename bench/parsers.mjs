// Parser adapters used by the benchmark. Each takes a GeoJSON file path and resolves to the number of features.
import fs from "node:fs";
import { Readable } from "node:stream";

const CHUNK_SIZE = 64 * 1024;

export const parsers = {
    "JSON.parse": async file => JSON.parse(fs.readFileSync(file, "utf8")).features.length,

    "jsooner": async file => {
        const { toJsonAsyncIterable } = await import("../dist/index.js");
        let n = 0;
        for await (const _ of toJsonAsyncIterable(webStream(file), { lookup: '"features"' })) n++;
        return n;
    },

    "@streamparser/json": async file => {
        const { JSONParser } = await import("@streamparser/json-whatwg");
        let n = 0;
        const stream = webStream(file).pipeThrough(new JSONParser({ paths: ["$.features.*"], keepStack: false }));
        for await (const _ of stream) n++;
        return n;
    },

    "stream-json": async file => {
        const { parser } = await import("stream-json");
        const { pick } = await import("stream-json/filters/pick.js");
        const { streamArray } = await import("stream-json/streamers/stream-array.js");
        const { default: chain } = await import("stream-chain");
        let n = 0;
        await new Promise((resolve, reject) =>
            chain([fs.createReadStream(file, { highWaterMark: CHUNK_SIZE }), parser(), pick({ filter: "features" }), streamArray()])
                .on("data", () => n++).on("end", resolve).on("error", reject));
        return n;
    },

    "bfj": async file => {
        const { default: bfj } = await import("bfj");
        let n = 0;
        // the JSONPath selector "$.features[*]" matches nothing in bfj 9.1.3, so select array elements
        // at depth 2 instead; in this document those are exactly the items of "features".
        // minDepth keeps bfj from assembling the shallower values (the whole document) for the predicate
        const isFeature = (key, value, depth) => depth === 2 && typeof key === "number";
        await new Promise((resolve, reject) =>
            bfj.match(fs.createReadStream(file, { highWaterMark: CHUNK_SIZE }), isFeature, { minDepth: 2 })
                .on("data", () => n++).on("end", resolve).on("error", reject).on("dataError", reject));
        return n;
    },

    "json-ext parseChunked": async file => {
        const { parseChunked } = await import("@discoveryjs/json-ext");
        return (await parseChunked(fs.createReadStream(file, { highWaterMark: CHUNK_SIZE }))).features.length;
    },
};

function webStream(file) {
    return Readable.toWeb(fs.createReadStream(file, { highWaterMark: CHUNK_SIZE }));
}
