/**
 * V3 graphics-backend preference.
 *
 * The main renderer can run on WebGL2 (default, verified) or WebGPU
 * (experimental — several GPU readback / data-processor paths still need
 * per-host verification). The choice is persisted so the settings panel can
 * offer a durable switch. Precedence at device creation:
 *   1. URL / CLI override (?gpu=webgpu, --gpu=webgpu) — debugging
 *   2. persisted preference (settings panel)
 *   3. default WebGL2
 */

const KEY = 'splatroom.gpuBackend';

export type GpuBackend = 'webgl2' | 'webgpu';

const isBackend = (v: unknown): v is GpuBackend => v === 'webgl2' || v === 'webgpu';

/** Persisted preference, or undefined when unset. */
export const getGpuBackendPref = (): GpuBackend | undefined => {
    try {
        const v = window.localStorage.getItem(KEY);
        return isBackend(v) ? v : undefined;
    } catch {
        return undefined;
    }
};

/** Persist the choice (takes effect on the next app start). */
export const setGpuBackendPref = (backend: GpuBackend) => {
    try {
        window.localStorage.setItem(KEY, backend);
    } catch { /* storage unavailable */ }
};
