// Renders benchmark results as a scatter plot: parsing time (x) against peak RSS (y).
// Usage: node bench/chart.mjs [results=assets/benchmark-results.json] [out=assets/benchmark.png]
// bench/run.mjs calls renderChart() after each run; use this CLI to re-render saved results.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const HIGHLIGHT = "jsooner";

// Reference light palette (dataviz skill): surface, text tokens, hairline grid, one highlight hue
const COLORS = {
    surface: "#fcfcfb",
    textPrimary: "#0b0b0b",
    textSecondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    highlight: "#2a78d6",
    other: "#898781",
};
const FONT = "Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif";

const WIDTH = 960;
const HEIGHT = 600;
const PLOT = { left: 84, right: 40, top: 96, bottom: 72 };
const POINT_RADIUS = 6;

// Log-axis ticks on the 1-2-5 sequence; the domain runs from the tick below min to the tick above max.
// Both axes are logarithmic because parsers differ by ratios (times span ~70×, memory ~20×),
// which a linear axis would squash into one corner.
function logTicks(min, max) {
    const all = [];
    for (let e = Math.floor(Math.log10(min)) - 1; e <= Math.ceil(Math.log10(max)); e++)
        for (const m of [1, 2, 5]) all.push(+(m * 10 ** e).toPrecision(12));
    const lo = all.filter(t => t <= min / 1.1).pop();
    const hi = all.find(t => t >= max * 1.1);
    return all.filter(t => t >= lo && t <= hi);
}

const escape = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Rough width of sans-serif text; used only to keep labels inside the plot and apart from each other
const textWidth = (s, size) => s.length * size * 0.56;

function text(x, y, content, { size = 13, color = COLORS.textSecondary, anchor = "start", weight = 400 } = {}) {
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escape(content)}</text>`;
}

/**
 * @param {{ name: string, seconds: number, rssMb: number }[]} results
 * @param {{ fileMb?: number, items?: number, node?: string, platform?: string, baselineRssMb?: number }} meta
 * @returns {string} SVG markup
 */
export function chartSvg(results, meta = {}) {
    const ok = results.filter(r => Number.isFinite(r.seconds) && Number.isFinite(r.rssMb));
    const times = ok.map(r => r.seconds);
    const memory = ok.map(r => r.rssMb).concat(meta.baselineRssMb ? [meta.baselineRssMb] : []);
    const xTicks = logTicks(Math.min(...times), Math.max(...times));
    const yTicks = logTicks(Math.min(...memory), Math.max(...memory));

    const plotW = WIDTH - PLOT.left - PLOT.right;
    const plotH = HEIGHT - PLOT.top - PLOT.bottom;
    const logScale = (ticks, from, to) => {
        const lo = Math.log10(ticks[0]), hi = Math.log10(ticks[ticks.length - 1]);
        return v => from + ((Math.log10(v) - lo) / (hi - lo)) * (to - from);
    };
    const sx = logScale(xTicks, PLOT.left, PLOT.left + plotW);
    const sy = logScale(yTicks, PLOT.top + plotH, PLOT.top);

    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`);
    out.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.surface}"/>`);

    // Title and subtitle
    out.push(text(PLOT.left, 40, "Parsing time vs peak memory", { size: 20, color: COLORS.textPrimary, weight: 600 }));
    const subtitle = [
        meta.fileMb && `${meta.fileMb} MB GeoJSON`,
        meta.items && `${meta.items.toLocaleString("en-US")} features`,
        "64 KB chunks",
        meta.node && `Node ${meta.node}`,
        meta.platform,
    ].filter(Boolean).join(" · ");
    out.push(text(PLOT.left, 64, subtitle, { size: 13 }));
    out.push(text(WIDTH - PLOT.right, 64, "Lower left is better", { size: 13, color: COLORS.muted, anchor: "end" }));

    // Gridlines and tick labels
    for (const t of yTicks) {
        const y = sy(t);
        out.push(`<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`);
        out.push(text(PLOT.left - 10, y + 4, t, { size: 12, color: COLORS.muted, anchor: "end" }));
    }
    for (const t of xTicks) {
        const x = sx(t);
        out.push(`<line x1="${x}" x2="${x}" y1="${PLOT.top}" y2="${PLOT.top + plotH}" stroke="${COLORS.grid}" stroke-width="1"/>`);
        out.push(text(x, PLOT.top + plotH + 20, t, { size: 12, color: COLORS.muted, anchor: "middle" }));
    }

    // Axis titles
    out.push(text(PLOT.left + plotW / 2, HEIGHT - 20, "Parsing time, s (log scale)", { size: 13, anchor: "middle" }));
    out.push(`<g transform="translate(24 ${PLOT.top + plotH / 2}) rotate(-90)">${text(0, 0, "Peak RSS, MB (log scale)", { size: 13, anchor: "middle" })}</g>`);

    // Boxes that labels must avoid: every point, plus the reference line's own label
    const taken = ok.map(r => box(sx(r.seconds) - POINT_RADIUS, sy(r.rssMb) - POINT_RADIUS, POINT_RADIUS * 2, POINT_RADIUS * 2));

    // Reference line: memory of a Node process that does nothing, the floor no parser can go below
    if (meta.baselineRssMb) {
        const y = sy(meta.baselineRssMb);
        const label = `Empty Node process: ${meta.baselineRssMb} MB`;
        out.push(`<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${y}" y2="${y}" stroke="${COLORS.muted}" stroke-width="1"/>`);
        out.push(text(WIDTH - PLOT.right - 4, y - 6, label, { size: 12, color: COLORS.muted, anchor: "end" }));
        taken.push(box(WIDTH - PLOT.right - 4 - textWidth(label, 12), y - 18, textWidth(label, 12), 18));
    }

    // Points: highlight drawn last so it sits on top; each carries a 2px surface ring
    const ordered = [...ok].sort((a, b) => (a.name === HIGHLIGHT) - (b.name === HIGHLIGHT));
    for (const r of ordered) {
        const fill = r.name === HIGHLIGHT ? COLORS.highlight : COLORS.other;
        out.push(`<circle cx="${sx(r.seconds).toFixed(1)}" cy="${sy(r.rssMb).toFixed(1)}" r="${POINT_RADIUS}" fill="${fill}" stroke="${COLORS.surface}" stroke-width="2"/>`);
    }

    // Direct labels: name plus values. Try positions around the point in order of preference,
    // clamped inside the plot, and take the first that collides with nothing (else the least-overlapping one).
    // The highlight is placed first so it gets its preferred spot.
    for (const r of [...ordered].reverse()) {
        const name = r.name;
        const values = `${r.seconds.toFixed(2)} s · ${Math.round(r.rssMb)} MB`;
        const w = Math.max(textWidth(name, 14), textWidth(values, 12));
        const h = 34;
        const px = sx(r.seconds), py = sy(r.rssMb);
        const gap = POINT_RADIUS + 6;
        const clampX = x => Math.min(Math.max(x, PLOT.left + 4), WIDTH - PLOT.right - 4 - w);
        const clampY = y => Math.min(Math.max(y, PLOT.top + 4), PLOT.top + plotH - 4 - h);
        const candidates = [
            { x: px + gap, y: py - h / 2, anchor: "start" },              // right
            { x: px - gap - w, y: py - h / 2, anchor: "end" },            // left
            { x: px + gap / 2, y: py - gap - h, anchor: "start" },        // above right
            { x: px + gap / 2, y: py + gap, anchor: "start" },            // below right
            { x: px - gap / 2 - w, y: py - gap - h, anchor: "end" },      // above left
            { x: px - gap / 2 - w, y: py + gap, anchor: "end" },          // below left
        ].map(c => ({ ...c, x: clampX(c.x), y: clampY(c.y) }));
        const overlapArea = c => taken.reduce((sum, t) => sum + intersection(t, box(c.x, c.y, w, h)), 0);
        const place = candidates.find(c => overlapArea(c) === 0) ?? candidates.reduce((a, b) => overlapArea(b) < overlapArea(a) ? b : a);
        taken.push(box(place.x, place.y, w, h));

        const tx = place.anchor === "start" ? place.x : place.x + w;
        const isHighlight = name === HIGHLIGHT;
        out.push(text(tx, place.y + 14, name, { size: 14, color: COLORS.textPrimary, anchor: place.anchor, weight: isHighlight ? 600 : 400 }));
        out.push(text(tx, place.y + 30, values, { size: 12, anchor: place.anchor }));
    }

    out.push("</svg>");
    return out.join("\n");
}

const box = (x, y, w, h) => ({ x, y, w, h });
const intersection = (a, b) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Writes the chart as PNG (2× for sharp text) and as SVG next to it; returns both paths. */
export function renderChart(results, meta, outFile = "assets/benchmark.png") {
    const svg = chartSvg(results, meta);
    const png = new Resvg(svg, {
        fitTo: { mode: "width", value: WIDTH * 2 },
        font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
    }).render().asPng();
    const svgFile = outFile.replace(/\.png$/i, "") + ".svg";
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, png);
    fs.writeFileSync(svgFile, svg + "\n");
    return [outFile, svgFile];
}

// Run as a CLI only when executed directly, not when imported by run.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [resultsFile = "assets/benchmark-results.json", outFile] = process.argv.slice(2);
    const { results, meta } = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    console.log(`Chart written to ${renderChart(results, meta, outFile).join(" and ")}`);
}
