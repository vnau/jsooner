import { JsonDecoder, JsonParserConfig, JsonParserStat } from "./JsonDecoder.js";

// Returns the byte stream of a ReadableStream or a Response. Checks for a stream by feature rather
// than with `instanceof Response`: in Node, touching the global Response loads the whole fetch
// implementation, which a caller reading a file or stdin never needs.
export function sourceStream(source: ReadableStream<Uint8Array> | Response): ReadableStream<Uint8Array> {
    const stream = typeof (source as ReadableStream<Uint8Array> | null)?.getReader === "function"
        ? source as ReadableStream<Uint8Array>
        : (source as Response | null)?.body;

    if (!stream) {
        throw new Error('No readable stream found.');
    }
    return stream;
}

// A Uint8Array view of any byte chunk; sources may deliver other ArrayBuffer views or an ArrayBuffer,
// which TextDecoderStream accepted as well
function toBytes(chunk: ArrayBufferView | ArrayBufferLike): Uint8Array {
    if (chunk instanceof Uint8Array)
        return chunk;
    return ArrayBuffer.isView(chunk)
        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : new Uint8Array(chunk);
}

// Large source chunks are decoded and scanned in slices of this many bytes. A whole 1–4 MB chunk would
// become one large string, which V8 keeps in large-object space until a full GC, and it makes V8 grow
// its young generation to 64–128 MB. With 64 KB slices the peak stays near that of 64 KB chunks
// (1 MB chunks: 175 → 101 MB RSS, 4 MB: 266 → 143 MB, and faster).
const SLICE_SIZE = 64 * 1024;

// Shared core of toJsonStream and toJsonAsyncIterable: reads one source chunk at a time,
// decodes it slice by slice with a plain TextDecoder and runs JsonDecoder on it directly,
// returning the completed items of each slice as one array. No TextDecoderStream or
// TransformStream is involved, so the per-item wrappers built on top only hand out array elements.
export class BatchReader<T> {
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private text = new TextDecoder();
    private decoder: JsonDecoder<T>;
    private chunk: Uint8Array | null = null;   // source chunk still being decoded slice by slice
    private offset = 0;
    private items: T[] = [];
    private ended = false;
    private terminated = false;
    private failed = false;
    private failure: unknown;

    // Stand-in for a TransformStreamDefaultController: JsonDecoder only enqueues, terminates or errors
    private controller = {
        enqueue: (item: T) => { this.items.push(item); },
        terminate: () => { this.terminated = true; },
        error: (reason: unknown) => { this.failed = true; this.failure = reason; },
    } as unknown as TransformStreamDefaultController<T>;

    constructor(source: ReadableStream<Uint8Array>, config?: JsonParserConfig) {
        this.reader = source.getReader();
        this.decoder = new JsonDecoder<T>(config);
    }

    // Resolves to the next non-empty batch of items (from at most one slice), or null once the input is
    // exhausted. Items parsed before an invalid one are returned first; the error is thrown on the next call.
    async next(): Promise<T[] | null> {
        while (this.items.length === 0 && !this.failed && !this.ended) {
            if (this.chunk === null) {
                let result: ReadableStreamReadResult<Uint8Array>;
                try {
                    result = await this.reader.read();
                } catch (error) {
                    // The source itself failed
                    this.finish();
                    throw error;
                }
                if (result.done) {
                    const rest = this.text.decode();
                    if (rest)
                        this.decoder.transform(rest, this.controller);
                    this.finish();
                    break;
                }
                this.chunk = toBytes(result.value);
                this.offset = 0;
            }

            // Decode the next slice; TextDecoder's stream mode carries a multi-byte character cut at the boundary
            const end = Math.min(this.offset + SLICE_SIZE, this.chunk.length);
            const slice = this.offset === 0 && end === this.chunk.length ? this.chunk : this.chunk.subarray(this.offset, end);
            this.offset = end;
            if (end === this.chunk.length)
                this.chunk = null;
            this.decoder.transform(this.text.decode(slice, { stream: true }), this.controller);
            // "]" ended the array: stop the source, but still return the items parsed before it
            if (this.terminated)
                await this.cancel();
        }

        if (this.items.length > 0) {
            const batch = this.items;
            this.items = [];
            return batch;
        }
        if (this.failed) {
            const failure = this.failure;
            this.failed = false;
            await this.cancel(failure);
            throw failure;
        }
        return null;
    }

    // Stops reading and cancels the source, e.g. aborting a fetch download
    async cancel(reason?: unknown): Promise<void> {
        if (this.ended)
            return;
        this.ended = true;
        this.chunk = null;
        // Cancelling an errored source rejects with its error, which the consumer has already received
        await this.reader.cancel(reason).catch(() => { });
        this.reader.releaseLock();
    }

    public getStat(): JsonParserStat { return this.decoder.getStat(); }

    private finish(): void {
        this.ended = true;
        this.reader.releaseLock();
    }
}
