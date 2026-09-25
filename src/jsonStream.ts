import { JsonParserConfig } from "./JsonDecoder.js";
import { BatchReader, sourceStream } from "./batchReader.js";

export function toJsonStream<T>(source: ReadableStream<Uint8Array> | Response, config?: JsonParserConfig): ReadableStream<T> {
    const stream = sourceStream(source);

    // Each pull() decodes one source chunk and enqueues all its items at once; the next pull
    // happens only after the consumer has drained the queue, so backpressure reaches the source
    const core = new BatchReader<T>(stream, config);
    return new ReadableStream<T>({
        async pull(controller) {
            const batch = await core.next();
            if (batch === null) {
                controller.close();
                return;
            }
            for (const item of batch)
                controller.enqueue(item);
        },
        cancel(reason) {
            return core.cancel(reason);
        },
    });
};
