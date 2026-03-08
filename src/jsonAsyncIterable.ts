import { JsonParserConfig, JsonParserStat, JsonParserStream } from "./JsonDecoder.js";

class StreamToAsyncIterable<T> {
    private stream: ReadableStream<T>;
    private parserStream: JsonParserStream<T>;

    constructor(readableStream: ReadableStream<Uint8Array>, config?: JsonParserConfig) {
        this.parserStream = new JsonParserStream<T>(config);
        this.stream = readableStream.pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
            .pipeThrough(this.parserStream);
    }

    // Returns an async iterator that yields parsed JSON objects from the stream.
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        const reader = this.stream.getReader();

        try {
            let result: ReadableStreamReadResult<T>;
            while (!(result = await reader.read()).done) {
                yield result.value;
            }
        } finally {
            reader.releaseLock();
        }
    }
}

export function toJsonAsyncIterable<T>(source: ReadableStream<Uint8Array> | Response, config?: JsonParserConfig): AsyncIterable<T> {
    const stream = source instanceof Response ? source.body : source;

    if (!stream) {
        throw new Error('No readable stream found.');
    }

    return new StreamToAsyncIterable(stream, config);
};