/**
 * V3 graphics-backend preference.
 *
 * Both backends render splats: the WebGPU path uses WGSL twins of this project's custom
 * splat / centers-overlay shaders (src/shaders/splat-shader-wgsl.ts) plus a WGSL twin-free
 * overlay (src/shaders/splat-overlay-shader.ts with GSPLAT_QUAD_SPRITES). The choice is
 * therefore honoured at startup; see docs/V3-WebGPU-现状.md for what is verified on each
 * backend. Precedence at device creation:
 *   1. URL override (?gpu=webgpu / ?gpu=webgl2) — used by the verification harnesses
 *   2. persisted preference (set from the settings panel)
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
 * shader transpilers (glslang/twgsl) are not available", which was one of the
 * black-viewport causes on the WebGPU backend (see docs/V3-WebGPU-现状.md).
 * The splat and centers-overlay shaders now also ship hand-written WGSL twins,
 * but the remaining passes (picking, bound/histogram compute, gizmos, merge) are
 * GLSL-only, so these transpilers are still required.
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
