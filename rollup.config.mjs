import path from 'path';

import alias from '@rollup/plugin-alias';
import image from '@rollup/plugin-image';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import strip from '@rollup/plugin-strip';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

import copyAndWatch from './copy-and-watch.mjs';

// prod is release build
if (process.env.BUILD_TYPE === 'prod') {
    process.env.BUILD_TYPE = 'release';
}
// debug, profile, release
const BUILD_TYPE = process.env.BUILD_TYPE || 'release';
const ENGINE_DIR = path.resolve(`node_modules/playcanvas/build/playcanvas${BUILD_TYPE === 'debug' ? '.dbg' : ''}/src/index.js`);
const PCUI_DIR = path.resolve('node_modules/@playcanvas/pcui');
const HREF = process.env.BASE_HREF || '';

const outputHeader = () => {
    const BLUE_OUT = '\x1b[34m';
    const BOLD_OUT = '\x1b[1m';
    const REGULAR_OUT = '\x1b[22m';
    const RESET_OUT = '\x1b[0m';

    const title = [
        'Building SplatRoom',
        `type ${BOLD_OUT}${BUILD_TYPE}${REGULAR_OUT}`
    ].map(l => `${BLUE_OUT}${l}`).join('\n');
    console.log(`${BLUE_OUT}${title}${RESET_OUT}\n`);
};

outputHeader();

const application = {
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        copyAndWatch({
            targets: [
                {
                    src: 'src/index.html',
                    transform: (contents, filename) => {
                        return contents.toString().replace('__BASE_HREF__', HREF);
                    }
                },
                { src: 'src/manifest.json' },
                { src: 'static/images', dest: 'static' },
                { src: 'static/icons', dest: 'static' },
                { src: 'static/lib', dest: 'static' },
                { src: 'static/locales', dest: 'static' },
                { src: 'static/env/VertebraeHDRI_v1_512.png', dest: 'static/env' },
                // splat-transform 的 SOG writer 用 WebP worker 编码：bundle 里
                // `new URL('./worker.mjs', import.meta.url)` 解析为 dist/worker.mjs，
                // 缺失会导致 module worker 404 静默挂起 → 格式工厂 SOG 转换
                // 进度卡 45%（writeSource 阶段）。必须把 worker + wasm 打进 dist。
                { src: 'node_modules/@playcanvas/splat-transform/dist/worker.mjs', dest: '' },
                { src: 'node_modules/@playcanvas/splat-transform/lib/webp.wasm', dest: 'lib' }
            ]
        }),
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        typescript({
            tsconfig: './tsconfig.json'
        }),
        resolve(),
        image({ dom: false }),
        json(),
        scss({
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            },
            fileName: 'index.css',
            includePaths: [`${PCUI_DIR}/dist`],
            watch: 'src/ui/scss'
        }),
        BUILD_TYPE === 'release' &&
        strip({
            include: ['**/*.ts'],
            functions: ['Debug.exec']
        }),
        BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

const serviceWorker = {
    input: 'src/sw.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        json(),
        typescript(),
        {
            // 每次构建注入新的 BUILD_ID 时间戳 → sw.js 字节必变 → SW 必然重装，缓存必然刷新
            name: 'inject-build-id',
            renderChunk(code) {
                if (code.includes('__BUILD_ID__')) {
                    return code.replace('__BUILD_ID__', String(Date.now()));
                }
                return null;
            }
        }
        // BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

// Decode worker: runs splat-transform's CPU-bound materialize + morton reorder
// off the main thread. Bundled as its own ESM entry so it can be instantiated
// with `new Worker('load-worker.js', { type: 'module' })`.
const loadWorker = {
    input: 'src/workers/load-worker.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        resolve(),
        json(),
        typescript()
    ],
    treeshake: 'smallest',
    cache: false
};

// Surface refine worker: runs the CPU-bound analyze/flatten/split/cleanup
// pipeline off the main thread so complex models don't freeze the UI. Bundled
// as its own ESM entry, instantiated with `new Worker('surface-worker.js', ...)`.
const surfaceWorker = {
    input: 'src/workers/surface-worker.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        resolve(),
        json(),
        typescript()
    ],
    treeshake: 'smallest',
    cache: false
};

// LOD build worker (V3): decimates a large splat into coarser proxy levels off
// the main thread via splat-transform's adaptive decimation. Instantiated with
// `new Worker('lod-worker.js', { type: 'module' })`.
const lodWorker = {
    input: 'src/workers/lod-worker.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        resolve(),
        json(),
        typescript()
    ],
    treeshake: 'smallest',
    cache: false
};

// L1 integration probe (dev/test only): bundles the real worker client + the
// main-thread loader so a headless browser can assert byte-identical output.
// Gated behind BUILD_PROBE so production builds stay lean — run with:
//   BUILD_PROBE=1 node_modules/.bin/rollup -c
// then: node scripts/probe-load-worker.mjs
const lwProbe = {
    input: 'src/workers/lw-probe.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        resolve(),
        json(),
        typescript()
    ],
    treeshake: 'smallest',
    cache: false
};

const configs = [application, serviceWorker, loadWorker, surfaceWorker, lodWorker];
if (process.env.BUILD_PROBE) {
    configs.push(lwProbe);
}

export default configs;
