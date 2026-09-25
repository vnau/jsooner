import { JsonParserConfig } from "./JsonDecoder.js";
import { BatchReader, sourceStream } from "./batchReader.js";

// Hands out the items of the current batch with already-resolved promises and asks the
// core for the next batch only when it runs out. A plain iterator object instead of an
// async generator, so there is no extra per-item await.
class JsonAsyncIterator<T> implements AsyncIterator<T, undefined> {
    private batch: T[] = [];
    private index = 0;

    constructor(private core: BatchReader<T>) { }

    next(): Promise<IteratorResult<T, undefined>> {
        if (this.index < this.batch.length)
            return Promise.resolve({ value: this.take(), done: false });

        return this.core.next().then(batch => {
            if (batch === null)
                return { value: undefined, done: true };
            this.batch = batch;
            this.index = 0;
            return { value: this.take(), done: false };
        });
    }

    // Clears the slot as the item is handed out, so items the consumer has finished with don't stay
    // reachable through the batch; otherwise they survive scavenges and V8 grows its young generation
    private take(): T {
        const value = this.batch[this.index];
        this.batch[this.index++] = undefined as T;
        return value;
    }

    // Called by for-await on break, return or a throw in the loop body:
    // cancel so the cancellation reaches the source, e.g. aborting a fetch download
    async return(): Promise<IteratorResult<T, undefined>> {
        this.batch = [];
        this.index = 0;
        await this.core.cancel();
        return { value: undefined, done: true };
    }
}

class JsonAsyncIterable<T> implements AsyncIterable<T> {
    private core: BatchReader<T>;

    constructor(stream: ReadableStream<Uint8Array>, config?: JsonParserConfig) {
        this.core = new BatchReader<T>(stream, config);
    }

    // Returns an async iterator that yields parsed JSON objects from the stream.
    [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
        return new JsonAsyncIterator(this.core);
    }
}

export function toJsonAsyncIterable<T>(source: ReadableStream<Uint8Array> | Response, config?: JsonParserConfig): AsyncIterable<T> {
    return new JsonAsyncIterable<T>(sourceStream(source), config);
};
