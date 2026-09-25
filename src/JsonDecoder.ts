export interface JsonParserConfig {
    lookup: string;
}

export interface JsonParserStat {
    maxBufferLength: number;
    chunks: number;
    maxChunkSize: number;
    length: number;
    items: number;
}

const NEWLINE = 0x0a;       // \n
const QUOTE = 0x22;         // "
const BACKSLASH = 0x5c;     // \
const OPEN_BRACE = 0x7b;    // {
const CLOSE_BRACE = 0x7d;   // }
const OPEN_BRACKET = 0x5b;  // [
const CLOSE_BRACKET = 0x5d; // ]

// Characters String.prototype.trim() would skip before a closing bracket
function isWhitespace(c: number): boolean {
    return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0xfeff;
}

export class JsonDecoder<T> implements Transformer<string, T> {
    private stat: JsonParserStat = {
        maxBufferLength: 0,
        chunks: 0,
        length: 0,
        items: 0,
        maxChunkSize: 0,
    };
    private isCompleted = false;
    private prefixSkipped = false;
    private prefix: string | null;
    private prefixLength: number = 0;
    // Last characters seen while searching for the prefix, so a prefix split across chunks is still found
    private lookupTail = "";

    // Scanner state carried between chunks, so every character is scanned exactly once
    private depth = 0;              // brace depth inside the current item; 0 between items
    private inString = false;
    private escaped = false;
    private atItemBoundary = true;  // no non-whitespace seen since the last item (or the prefix)
    private beforeValue = false;    // right after the prefix, before the value it names has started
    private parts: string[] = [];   // text of an unfinished item from earlier chunks
    private partsLength = 0;

    constructor(config?: JsonParserConfig) {
        this.prefix = config?.lookup ?? null;
        if (this.prefix)
            this.prefixLength = this.prefix.length;
        this.prefixSkipped = !this.prefix;
    }

    start(controller: TransformStreamDefaultController<T>): void { }

    transform(chunk: string, controller: TransformStreamDefaultController<T>): void {
        const chunkLength = chunk.length;
        this.stat.maxChunkSize = Math.max(this.stat.maxChunkSize, chunkLength);
        this.stat.chunks++;
        this.stat.length += chunkLength;

        if (this.isCompleted)
            return;

        let text = chunk;
        if (!this.prefixSkipped && this.prefix) {
            const window = this.lookupTail + chunk;
            const prefixIndex = window.indexOf(this.prefix);
            if (prefixIndex === -1) {
                this.stat.maxBufferLength = Math.max(this.stat.maxBufferLength, window.length);
                this.lookupTail = window.slice(-this.prefixLength);
                return;
            }
            this.prefixSkipped = true;
            this.beforeValue = true;
            this.lookupTail = "";
            text = window.slice(prefixIndex + this.prefixLength);
        }

        this.stat.maxBufferLength = Math.max(this.stat.maxBufferLength, this.partsLength + text.length);
        this.scan(text, controller);
    }

    flush(controller: TransformStreamDefaultController<T>): void { }

    public getStat(): JsonParserStat { return this.stat; }

    private scan(text: string, controller: TransformStreamDefaultController<T>): void {
        // Locals instead of fields in the hot loop
        let depth = this.depth;
        let inString = this.inString;
        let escaped = this.escaped;
        let atItemBoundary = this.atItemBoundary;
        let beforeValue = this.beforeValue;
        let start = depth > 0 ? 0 : -1;
        const length = text.length;
        let i = 0;

        // The previous chunk ended inside a string right after a backslash: this chunk's first character is escaped
        if (inString && escaped && length > 0) {
            i = 1;
            escaped = false;
        }

        while (i < length) {
            if (depth === 0) {
                // Right after the lookup string (e.g. `": [` after `"features`), skip to the start of its value.
                // A "[" opens the target array, so a "]" right after it ends the stream even when the array is
                // empty; a "{" is its first item; a "]" before either ends the stream (a lookup ending in "[").
                if (beforeValue) {
                    while (i < length) {
                        const c = text.charCodeAt(i);
                        if (c === OPEN_BRACKET || c === OPEN_BRACE || c === CLOSE_BRACKET) {
                            beforeValue = false;
                            atItemBoundary = true;
                            if (c === OPEN_BRACKET)
                                i++;
                            break;
                        }
                        i++;
                    }
                    continue;
                }

                // A string between items, e.g. the primitive "a{b" in ["a{b",{...}]: skip it so its braces don't
                // start an item. Rare, so a plain loop. A JSON string can't contain a raw newline, so a newline
                // ends it too: the quote was then part of non-JSON text, such as an SSE field (`event: "x`).
                if (inString) {
                    while (i < length) {
                        const c = text.charCodeAt(i++);
                        if (escaped) escaped = false;
                        else if (c === BACKSLASH) escaped = true;
                        else if (c === QUOTE || c === NEWLINE) {
                            inString = false;
                            break;
                        }
                    }
                    continue;
                }

                // Between items: a "]" as the first non-whitespace after an item ends the stream,
                // and anything else up to the next "{" is skipped, except strings (see above)
                if (atItemBoundary) {
                    let c = text.charCodeAt(i);
                    while (isWhitespace(c) && ++i < length)
                        c = text.charCodeAt(i);
                    if (i >= length)
                        break;
                    if (c === CLOSE_BRACKET) {
                        this.isCompleted = true;
                        this.parts = [];
                        controller.terminate();
                        return;
                    }
                    atItemBoundary = false;
                }
                const open = text.indexOf("{", i);
                // Look for a string start only in the gap before the next "{": usually just `,` and whitespace,
                // so a short loop beats indexOf, which could search far past the "{"
                const gapEnd = open === -1 ? length : open;
                let quote = -1;
                if (gapEnd - i > 32) {
                    quote = text.indexOf('"', i);
                    if (quote >= gapEnd) quote = -1;
                } else {
                    for (let k = i; k < gapEnd; k++)
                        if (text.charCodeAt(k) === QUOTE) { quote = k; break; }
                }
                if (quote !== -1) {
                    inString = true;
                    i = quote + 1;
                    continue;
                }
                if (open === -1)
                    break;
                depth = 1;
                start = open;
                i = open + 1;
                continue;
            }

            if (inString) {
                // Jump to the closing quote; a quote preceded by an odd number of backslashes is escaped
                const stringStart = i;
                let quote = text.indexOf('"', i);
                while (quote !== -1) {
                    let k = quote - 1;
                    while (k >= stringStart && text.charCodeAt(k) === BACKSLASH) k--;
                    if (((quote - 1 - k) & 1) === 0)
                        break;
                    quote = text.indexOf('"', quote + 1);
                }
                if (quote === -1) {
                    // The string continues in the next chunk; remember whether it ends on an unpaired backslash
                    let k = length - 1;
                    while (k >= stringStart && text.charCodeAt(k) === BACKSLASH) k--;
                    escaped = ((length - 1 - k) & 1) === 1;
                    break;
                }
                inString = false;
                i = quote + 1;
                continue;
            }

            const c = text.charCodeAt(i++);
            if (c === QUOTE) {
                inString = true;
            } else if (c === OPEN_BRACE) {
                depth++;
            } else if (c === CLOSE_BRACE && --depth === 0) {
                // Common case: the item starts and ends in this chunk, so it is sliced once
                let json: string;
                if (this.parts.length === 0) {
                    json = text.slice(start, i);
                } else {
                    this.parts.push(text.slice(0, i));
                    json = this.parts.join("");
                    this.parts = [];
                    this.partsLength = 0;
                }
                start = -1;
                atItemBoundary = true;

                let parsedObj: T;
                try {
                    parsedObj = JSON.parse(json);
                } catch (error) {
                    this.isCompleted = true;
                    controller.error(`JSON parse error: ${error}`);
                    return;
                }
                controller.enqueue(parsedObj);
                this.stat.items++;
            }
        }

        if (start >= 0) {
            const rest = start === 0 ? text : text.slice(start);
            this.parts.push(rest);
            this.partsLength += rest.length;
        }
        this.depth = depth;
        this.inString = inString;
        this.escaped = escaped;
        this.atItemBoundary = atItemBoundary;
        this.beforeValue = beforeValue;
    }
}

export class JsonParserStream<T> extends TransformStream<string, T> {
    private decoder: JsonDecoder<T>;
    constructor(config?: JsonParserConfig) {
        const decoder = new JsonDecoder<T>(config);
        super(decoder);
        this.decoder = decoder;
    }

    public getStat(): JsonParserStat { return this.decoder.getStat(); }
}