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

// Shared core of toJsonStream and toJsonAsyncIterable: reads one source chunk at a time,
// decodes it with a plain TextDecoder and runs JsonDecoder on it directly, returning the
// completed items as one array. No TextDecoderStream or TransformStream is involved, so
// the per-item wrappers built on top only hand out array elements.
export class BatchReader<T> {
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private text = new TextDecoder();
    private decoder: JsonDecoder<T>;
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

    // Resolves to the next non-empty batch of items, or null once the input is exhausted.
    // Items parsed before an invalid one are returned first; the error is thrown on the next call.
    async next(): Promise<T[] | null> {
        while (this.items.length === 0 && !this.failed && !this.ended) {
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
            this.decoder.transform(this.text.decode(result.value, { stream: true }), this.controller);
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
