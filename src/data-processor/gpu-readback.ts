/**
 * Shared guards for GPU texture readbacks (PIXEL_PACK_BUFFER + fence sync).
 *
 * PlayCanvas' async read (texture.read -> readPixelsAsync -> clientWaitAsync)
 * polls `clientWaitSync` with timeout 0 every 16ms, indefinitely. If the GPU
 * queue is still busy — e.g. right after a replaceData uploaded a large splat
 * — the poll can stall long enough for the driver watchdog to fire (monitor
 * black screen / TDR). All readback sites in the data processors must:
 *
 *   1. yield one animation frame so the queue drains before reading;
 *   2. bound the wait with a timeout and degrade gracefully on failure
 *      (keep previous data / return an empty result) instead of blocking the
 *      pipeline forever.
 */

/** Max time to wait for a GPU readback before degrading. */
export const READBACK_TIMEOUT_MS = 1500;

/**
 * Yield one animation frame so pending GPU uploads/renders drain first.
 * rAF is throttled/paused when the page is hidden or the window minimized, so
 * bound the wait with a timer — otherwise the readback (and its caller, e.g.
 * updateState during a backgrounded tab) would hang forever before even
 * reaching the readback timeout.
 */
export const waitForGpuDrain = (): Promise<void> => Promise.race([
    new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    }),
    new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
    })
]);

/**
 * Resolve when `p` settles, or reject after `ms` milliseconds. The underlying
 * promise is NOT cancelled (the engine poll keeps running) — this only stops
 * the caller from blocking the pipeline while the GPU is stalled.
 */
export const withReadbackTimeout = <T>(p: Promise<T>, ms: number = READBACK_TIMEOUT_MS): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('GPU readback timeout')), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
};
