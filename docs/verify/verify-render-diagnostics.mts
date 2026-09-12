// Unit checks for src/render-diagnostics.ts, run straight from source with
// Node's type stripping (no build needed):
//   node --experimental-strip-types docs/verify/verify-render-diagnostics.mts
//
// Covers the case reported from the field: the experimental WebGPU backend
// renders small models but leaves a large one blank, because the backend keeps
// the sort order in one u32-per-splat storage buffer that can exceed the
// adapter's binding/buffer limits.
import { renderDiagnostics } from '../../src/render-diagnostics.ts';

const splat = (opts: {
    numSplats: number,
    webgpu?: boolean,
    limits?: any,
    orderTexture?: boolean,
    sorter?: boolean,
    instancing?: number,
    dims?: { x: number, y: number }
}) => {
    const instance: any = {
        orderTexture: opts.orderTexture === false ? undefined : {},
        sorter: opts.sorter === false ? null : { pendingSorted: { count: opts.numSplats } },
        resource: { streams: { textureDimensions: opts.dims ?? { x: 1024, y: 1024 } } },
        meshInstance: { instancingCount: opts.instancing ?? Math.ceil(opts.numSplats / 128) }
    };
    return {
        name: 'model.ply',
        numSplats: opts.numSplats,
        entity: { gsplat: { instance }, parent: {}, enabled: true },
        scene: { graphicsDevice: { isWebGPU: !!opts.webgpu, limits: opts.limits } }
    } as any;
};

const webgpuLimits = { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192 };

const cases = [
    {
        name: 'webgl2 healthy model',
        input: splat({ numSplats: 2_000_000 }),
        expect: { ok: true, summaryIncludes: 'renderable', warnings: 0 }
    },
    {
        name: 'webgl2 without an order texture is not renderable',
        input: splat({ numSplats: 1000, orderTexture: false }),
        expect: { ok: false, summaryIncludes: 'hasOrderTexture', warnings: 0 }
    },
    {
        name: 'webgpu small model is renderable (no order texture by design)',
        input: splat({ numSplats: 2_000_000, webgpu: true, orderTexture: false, limits: webgpuLimits }),
        expect: { ok: true, summaryIncludes: 'renderable', warnings: 1 }
    },
    {
        name: 'webgpu 30M splats fits the 128 MB binding limit',
        input: splat({ numSplats: 30_000_000, webgpu: true, orderTexture: false, limits: webgpuLimits }),
        expect: { ok: true, summaryIncludes: 'renderable', warnings: 1 }
    },
    {
        name: 'webgpu 50M splats exceeds the binding limit',
        input: splat({ numSplats: 50_000_000, webgpu: true, orderTexture: false, limits: webgpuLimits }),
        expect: { ok: false, summaryIncludes: 'storage buffer binding', warnings: 1 }
    },
    {
        name: 'webgpu oversized splat texture is reported',
        input: splat({ numSplats: 1000, webgpu: true, orderTexture: false, limits: webgpuLimits, dims: { x: 16384, y: 16384 } }),
        expect: { ok: false, summaryIncludes: 'limits textures', warnings: 1 }
    },
    {
        name: 'webgpu with no sort result (nothing drawn) is reported',
        input: splat({ numSplats: 5_000_000, webgpu: true, orderTexture: false, limits: webgpuLimits, instancing: 0 }),
        expect: { ok: false, summaryIncludes: 'no drawable instances', warnings: 1 }
    }
];

let failed = 0;
for (const testCase of cases) {
    const result = renderDiagnostics(testCase.input);
    const problems: string[] = [];
    if (result.ok !== testCase.expect.ok) problems.push(`ok=${result.ok} expected ${testCase.expect.ok}`);
    if (!result.summary.includes(testCase.expect.summaryIncludes)) problems.push(`summary "${result.summary}" lacks "${testCase.expect.summaryIncludes}"`);
    if (result.warnings.length !== testCase.expect.warnings) problems.push(`${result.warnings.length} warnings expected ${testCase.expect.warnings}`);
    if (problems.length) {
        failed++;
        console.log(`FAIL ${testCase.name}\n     ${problems.join('; ')}\n     summary: ${result.summary}`);
    } else {
        console.log(`ok   ${testCase.name} — ${result.summary}`);
    }
}

console.log(failed ? `\n${failed} of ${cases.length} checks failed` : `\nall ${cases.length} checks passed`);
process.exitCode = failed ? 1 : 0;
