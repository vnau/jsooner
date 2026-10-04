// Runs every parser in its own process, prints a markdown table, and saves
// assets/benchmark-results.json and a scatter plot assets/benchmark.svg (+ .png).
// Usage: node bench/run.mjs [file=bench/data/big.geojson]
// Requires `pnpm build` (jsooner is loaded from dist/) and `node bench/generate.mjs`.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parsers } from "./parsers.mjs";
import { renderChart } from "./chart.mjs";

const RESULTS_DIR = "assets";

const file = process.argv[2] ?? "bench/data/big.geojson";
if (!fs.existsSync(file)) {
    console.error(`${file} not found. Run: node bench/generate.mjs`);
    process.exit(1);
}

// Peak RSS of a Node process that does nothing: the floor under every parser's number
const baselineRssMb = Math.round(Number(execFileSync(process.execPath, ["-e", "console.log(process.resourceUsage().maxRSS / 1024)"], { encoding: "utf8" })));
const meta = {
    fileMb: Math.round(fs.statSync(file).size / 1e6),
    node: process.version,
    platform: process.platform,
    baselineRssMb,
};

console.log(`${file}, ${meta.fileMb} MB, Node ${meta.node}, ${meta.platform}, empty process ${baselineRssMb} MB RSS\n`);
console.log("| Parser | Items | Time, s | Peak RSS, MB |");
console.log("|---|---:|---:|---:|");
const results = [];
for (const name of Object.keys(parsers)) {
    try {
        const result = JSON.parse(execFileSync(process.execPath, ["bench/parse.mjs", name, file], { encoding: "utf8" }));
        results.push(result);
        console.log(`| ${name} | ${result.items} | ${result.seconds.toFixed(2)} | ${result.rssMb.toFixed(0)} |`);
    } catch (error) {
        console.log(`| ${name} | failed: ${error.message.split("\n")[0]} | | |`);
    }
}
meta.items = results[0]?.items;

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(`${RESULTS_DIR}/benchmark-results.json`, JSON.stringify({ meta, results }, null, 2) + "\n");
console.log(`\nResults written to ${RESULTS_DIR}/benchmark-results.json`);
console.log(`Chart written to ${renderChart(results, meta, `${RESULTS_DIR}/benchmark.png`).join(" and ")}`);
