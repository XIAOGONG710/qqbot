/** A small in-process concurrency gate. Queued work is removed immediately when cancelled. */
export class AsyncGate {
    readonly #limit: number;
    #active = 0;
    readonly #waiting: (() => void)[] = [];

    constructor(limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be a positive integer');
        this.#limit = limit;
    }

    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('cancelled', 'AbortError'));
        return new Promise<T>((resolve, reject) => {
            let queued = true;
            const cancel = () => {
                if (!queued) return;
                const at = this.#waiting.indexOf(start);
                if (at >= 0) this.#waiting.splice(at, 1);
                queued = false;
                reject(signal?.reason ?? new DOMException('cancelled', 'AbortError'));
            };
            const start = () => {
                if (!queued) return;
                queued = false;
                signal?.removeEventListener('abort', cancel);
                this.#active++;
                Promise.resolve().then(work).then(resolve, reject).finally(() => {
                    this.#active--;
                    this.#waiting.shift()?.();
                });
            };
            signal?.addEventListener('abort', cancel, { once: true });
            if (this.#active < this.#limit) start();
            else this.#waiting.push(start);
        });
    }
}
