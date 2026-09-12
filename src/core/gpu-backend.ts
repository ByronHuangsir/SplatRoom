/**
 * V3 graphics-backend preference.
 *
 * WebGL2 is the only backend that can render splats in this build; the WebGPU
 * backend is kept for development behind the `?gpu=webgpu` URL override only
 * (see docs/V3-WebGPU-现状.md — the engine renders splats with its own WGSL
 * material on WebGPU, which ignores the GLSL splat chunks this project injects,
 * and our two-attachment splat pass is an invalid pipeline there, so every model
 * comes up on a black viewport). The stored preference is therefore reset to
 * webgl2 at startup instead of being honoured. Precedence at device creation:
 *   1. URL override (?gpu=webgpu) — development only
 *   2. persisted preference — refused while the backend cannot render
 *   3. default WebGL2
 */

const KEY = 'splatroom.gpuBackend';

/**
 * GLSL → SPIR-V → WGSL transpilers required by the WebGPU backend.
 *
 * PlayCanvas compiles our shader sources (every custom pass in this project is
 * GLSL) for WebGPU by transpiling them: glslang turns GLSL into SPIR-V, twgsl
 * (Tint) turns SPIR-V into WGSL. Without these two the device has no
 * `glslang`/`twgsl` and every GLSL shader fails with "Cannot transpile shader …
 * shader transpilers (glslang/twgsl) are not available". That was one of the two
 * black-viewport causes found on the WebGPU backend (the other is the engine's
 * WGSL splat material, see docs/V3-WebGPU-现状.md); wiring these URLs is required
 * for any WebGPU work, so the assets stay vendored even though the backend is
 * currently development-only.
 *
 * They are served from our own static assets (vendored from the PlayCanvas
 * engine repo's `examples/assets/wasm`) so the packaged desktop app works
 * offline. Paths resolve against document.baseURI, matching how the WebP wasm
 * is located in main.ts, so both `http://localhost:<port>/` (dev + Electron's
 * built-in server) and `file://` work.
 */
export const webgpuTranspilerUrls = (): { glslangUrl: string, twgslUrl: string } => {
    const url = (path: string) => new URL(path, document.baseURI).toString();
    return {
        glslangUrl: url('static/lib/wasm/glslang/glslang.js'),
        twgslUrl: url('static/lib/wasm/twgsl/twgsl.js')
    };
};

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
