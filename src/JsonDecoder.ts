import { getJsonSubstringLength } from './getJsonSubstringLength.js';

export interface JsonParserConfig {
    prefix: string;
}

export class JsonDecoder<T> implements Transformer<string, T> {
    private buffer = "";
    private isCompleted = false;
    private prefixSkipped = false;
    private prefix: string | null;

    constructor(config?: JsonParserConfig) {
        this.prefix = config?.prefix ?? null;
        this.prefixSkipped = !this.prefix;
    }

    start(controller: TransformStreamDefaultController<T>): void { }

    transform(chunk: string, controller: TransformStreamDefaultController<T>): void {
        if (this.isCompleted) return;

        this.buffer += chunk;

        if (!this.prefixSkipped && this.prefix) {
            const prefixIndex = this.buffer.indexOf(this.prefix);
            if (prefixIndex > -1) {
                this.prefixSkipped = true;
                const prefixEnd = prefixIndex + this.prefix.length;
                this.buffer = this.buffer.slice(prefixEnd);
            }
        }

        let jsonStart = 0;
        while ((jsonStart = this.buffer.indexOf("{", jsonStart)) !== -1) {
            const jsonLength = getJsonSubstringLength(this.buffer, jsonStart);
            const jsonEnd = jsonStart + jsonLength;
            if (jsonLength > 0) {
                const jsonStr = this.buffer.slice(jsonStart, jsonEnd);
                try {
                    const parsedObj: T = JSON.parse(jsonStr);
                    controller.enqueue(parsedObj);
                } catch (error) {
                    controller.error(`JSON parse error: ${error}`);
                    return;
                }
                this.buffer = this.buffer.slice(jsonEnd);
                jsonStart = 0;
            } else break;
        }

        if (this.buffer.trim().startsWith("]")) {
            this.isCompleted = true;
            controller.terminate();
        }
    }

    flush(controller: TransformStreamDefaultController<T>): void { }
}

export class JsonParserStream<T> extends TransformStream<string, T> {
    constructor(config?: JsonParserConfig) {
        super(new JsonDecoder<T>(config));
    }
}