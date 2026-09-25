# jsooner

[![npm](https://img.shields.io/npm/v/jsooner?color=brightgreen&logo=npm)](https://www.npmjs.com/package/jsooner)
![coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/vnau/7353726794cee33914eb47e39e6694c6/raw/jsooner__heads_main.json)
[![bundle size](https://badgen.net/bundlephobia/min/jsooner)](https://bundlephobia.com/package/jsooner)

`jsooner` is a lightweight, efficient library for parsing large JSON streams.

It’s specifically designed for handling long sequences of JSON objects in a fast and memory-efficient way, without aiming to be a full-featured JSON parser.

## Why jsooner?

Parsing large JSON files or continuous streams can overwhelm standard methods like `JSON.parse`, especially in terms of memory and speed. `jsooner` addresses these challenges with:

- _Efficiency:_ Parses JSON incrementally as data arrives, outperforming `JSON.parse` on streams.
- _Memory Optimization:_ Handles streaming data with minimal memory usage

## Installation

You can install `jsooner` via npm:

```bash
npm install jsooner
```

## Usage

Here's a basic example of how to use `jsooner`:

```TypeScript
import { toJsonAsyncIterable } from "jsooner";

const response = await fetch("https://raw.githubusercontent.com/vnau/jsooner/refs/heads/main/examples/data/point-samples.geojson");
const features = toJsonAsyncIterable(response, { lookup: '"features"' });
for await (const feature of features) {
    console.log(feature);
}
```

## Performance

`jsooner` has been benchmarked against other JavaScript JSON parsers that can stream items, as well as the native `JSON.parse` method. The input is a generated 136 MB GeoJSON file with 360,000 features, read in 64 KB chunks, with each parser in its own process.

![Parsing time vs peak memory](assets/benchmark.svg)

Lower left is better. `JSON.parse` and json-ext's `parseChunked` are faster, but they build the whole document in memory. Of the parsers that stream items one at a time, `jsooner` is the fastest and uses the least memory.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
