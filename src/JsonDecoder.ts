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

function getJsonSubstringLength(input: string, startIndex: number): number {
    let bracketBalance = 0;
    let isInsideString = false;

    for (let i = startIndex; i < input.length; i++) {
        const currentChar = input[i];

        if (isInsideString) {
            if (currentChar === '\\') {
                i++; // Skip escaped character
                continue;
            }
            if (currentChar === '"') isInsideString = false;
        } else {
            if (currentChar === '"') {
                isInsideString = true;
            } else {
                if (currentChar === '{') bracketBalance++;
                else if (currentChar === '}') bracketBalance--;

                if (bracketBalance === 0) return i - startIndex + 1;
            }
        }
    }

    return 0; // No complete JSON object found
}

export class JsonDecoder<T> implements Transformer<string, T> {
    private stat: JsonParserStat = {
        maxBufferLength: 0,
        chunks: 0,
        length: 0,
        items: 0,
        maxChunkSize: 0,
    };
    private buffer = "";
    private isCompleted = false;
    private prefixSkipped = false;
    private prefix: string | null;
    private prefixLength: number = 0;

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

        if (!this.prefixSkipped && this.prefix) {
            if (this.buffer.length >= this.prefixLength)
                this.buffer = this.buffer.slice(this.buffer.length - this.prefixLength);

            this.buffer += chunk;

            const prefixIndex = this.buffer.indexOf(this.prefix);
            if (prefixIndex > -1) {
                this.prefixSkipped = true;
                const prefixEnd = prefixIndex + this.prefix.length;
                this.buffer = this.buffer.slice(prefixEnd);
            }
        } else {
            this.buffer += chunk;
        }

        this.stat.maxBufferLength = Math.max(this.stat.maxBufferLength, this.buffer.length);

        let jsonStart = 0;
        while ((jsonStart = this.buffer.indexOf("{", jsonStart)) !== -1) {
            const jsonLength = getJsonSubstringLength(this.buffer, jsonStart);
            const jsonEnd = jsonStart + jsonLength;
            if (jsonLength > 0) {
                const jsonStr = this.buffer.slice(jsonStart, jsonEnd);
                try {
                    const parsedObj: T = JSON.parse(jsonStr);
                    controller.enqueue(parsedObj);
                    this.stat.items++;
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

    public getStat(): JsonParserStat { return this.stat; }
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