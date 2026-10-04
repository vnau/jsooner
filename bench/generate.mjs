// Generates a deterministic GeoJSON FeatureCollection for benchmarking.
// Usage: node bench/generate.mjs [featureCount=360000] [outFile=bench/data/big.geojson]
import fs from "node:fs";
import path from "node:path";

const count = Number(process.argv[2] ?? 360000);
const file = process.argv[3] ?? "bench/data/big.geojson";
fs.mkdirSync(path.dirname(file), { recursive: true });

// Seeded PRNG so every run produces the same file
let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const point = () => [rnd() * 360 - 180, rnd() * 180 - 90];

const out = fs.createWriteStream(file);
out.write('{"type":"FeatureCollection","name":"bench","features":[\n');
for (let i = 0; i < count; i++) {
    const polygon = i % 5 === 0;
    const feature = {
        type: "Feature",
        // escaped quotes and braces inside strings exercise the scanner's string handling
        properties: { id: i, name: `Place "${i}" {x}`, tags: ["a", "b"], value: rnd() * 1000, open: i % 2 === 0, note: null },
        geometry: polygon
            ? { type: "Polygon", coordinates: [Array.from({ length: 20 }, point)] }
            : { type: "Point", coordinates: point() },
    };
    if (!out.write((i ? ",\n" : "") + JSON.stringify(feature)))
        await new Promise(resolve => out.once("drain", resolve));
}
out.end("\n]}\n");
await new Promise(resolve => out.on("finish", resolve));
console.log(`${file}: ${count} features, ${(fs.statSync(file).size / 1e6).toFixed(0)} MB`);
