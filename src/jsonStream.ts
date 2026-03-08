import { JsonParserConfig, JsonParserStream } from "./JsonDecoder.js";

export function toJsonStream<T>(source: ReadableStream<Uint8Array> | Response, config?: JsonParserConfig): ReadableStream<T> {
    const stream = source instanceof Response ? source.body : source;

    if (!stream) {
        throw new Error('No readable stream found.');
    }

    return stream
        .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
        .pipeThrough(new JsonParserStream<T>(config));
};