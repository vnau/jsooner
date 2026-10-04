// Parses the benchmark file with one parser and prints the result as one line of JSON.
// Run through bench/run.mjs so each parser gets a fresh process (clean peak RSS).
// Usage: node bench/parse.mjs <parser> [file=bench/data/big.geojson]
import { parsers } from "./parsers.mjs";

const [name, file = "bench/data/big.geojson"] = process.argv.slice(2);
if (!parsers[name]) {
    console.error(`Unknown parser "${name}". Available: ${Object.keys(parsers).join(", ")}`);
    process.exit(1);
}

const start = performance.now();
const items = await parsers[name](file);
const seconds = (performance.now() - start) / 1000;
const rssMb = process.resourceUsage().maxRSS / 1024;
console.log(JSON.stringify({ name, items, seconds, rssMb }));
