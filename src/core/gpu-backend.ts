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
 *   3. default WebGPU (since 3.23.58 — the unified same-frame GPU sort path is on by
 *      default and needs WebGPU; browsers without WebGPU fall back to WebGL2 + mainline
 *      CPU sort, which is the old default experience)
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

/**
 * WebGPU's fragment position starts at the TOP-left, while GL's `gl_FragCoord` starts at the
 * bottom-left. The camera-ray uniforms (`near_origin`/`near_x`/`near_y` and
 * `far_origin`/`far_x`/`far_y`, filled by `Camera.updateCameraUniforms`) are laid out in the
 * GL convention, so every shader that turns a fragment coordinate back into a world-space ray
 * has to flip y on WebGPU. Without the flip the ray is mirrored vertically: the box/sphere
 * selection volumes draw their grid mirrored, and most fragments miss the volume entirely and
 * paint the shader's red "ray missed the box" fallback.
 *
 * Shaders that read gl_FragCoord only as a texel index or as a screen-space pattern (for
 * example the hatch in tool-overlay-shader, or the histogram tile index) do not need this.
 */
export const applyFragCoordDefine = (
    material: { setDefine: (name: string, value: string) => void },
    device: { isWebGPU: boolean }
) => {
    if (device.isWebGPU) {
        material.setDefine('GSPLAT_FRAGCOORD_TOPLEFT', '');
    }
};

/**
 * Same define as `applyFragCoordDefine`, for shaders built with `ShaderUtils.createShader`:
 * those are plain `Shader` objects without `Material#setDefine`, so the define is prepended
 * to the source instead. A define line is not part of the shader body, so this cannot change
 * line-based error reporting for the real source.
 */
export const withFragCoordDefine = (
    fragmentGLSL: string,
    device: { isWebGPU: boolean }
) => {
    return device.isWebGPU ? `#define GSPLAT_FRAGCOORD_TOPLEFT\n${fragmentGLSL}` : fragmentGLSL;
};

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
