// SplatRoom post-install patch script
// Automatically applies custom patches after `npm install`
// Cross-platform (Windows/macOS/Linux)

const fs = require('fs');
const path = require('path');

console.log('[SplatRoom] Applying patches...');

// Patch 1: splat-transform MAX_STRIPE_BYTES (8MB -> 128MB)
const targetPath = path.join('node_modules', '@playcanvas', 'splat-transform', 'dist', 'index.mjs');
const patchPath = path.join('patches', 'splat-transform-index.mjs');

if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, 'utf8');
    if (content.includes('MAX_STRIPE_BYTES = 128 * 1024 * 1024')) {
        console.log('[OK] Patch 1 already applied: MAX_STRIPE_BYTES = 128MB');
    } else if (content.includes('MAX_STRIPE_BYTES = 8 * 1024 * 1024')) {
        if (fs.existsSync(patchPath)) {
            fs.copyFileSync(patchPath, targetPath);
            console.log('[APPLIED] Patch 1: MAX_STRIPE_BYTES 8MB -> 128MB (file copied)');
        } else {
            // Fallback: sed-style replacement
            const patched = content.replace(
                /MAX_STRIPE_BYTES = 8 \* 1024 \* 1024/,
                'MAX_STRIPE_BYTES = 128 * 1024 * 1024'
            );
            fs.writeFileSync(targetPath, patched);
            console.log('[APPLIED] Patch 1: MAX_STRIPE_BYTES 8MB -> 128MB (inline edit)');
        }
    } else {
        console.log('[WARN] Patch 1: unexpected MAX_STRIPE_BYTES value, skipping');
    }
} else {
    console.log('[SKIP] Patch 1: ' + targetPath + ' not found');
}

// Patch 2: eslint-plugin-import order.js — ESLint 10 移除了
// sourceCode.getTokenOrCommentBefore / getTokenOrCommentAfter API，导致
// `npm run lint` 崩溃（TypeError: sourceCode.getTokenOrCommentBefore is not
// a function）。替换为官方推荐的 getTokenBefore/After(node, { includeComments: true })。
const importOrderPath = path.join('node_modules', '@playcanvas', 'eslint-config', 'node_modules', 'eslint-plugin-import', 'lib', 'rules', 'order.js');

if (fs.existsSync(importOrderPath)) {
    const content = fs.readFileSync(importOrderPath, 'utf8');
    if (!content.includes('getTokenOrComment')) {
        console.log('[OK] Patch 2 already applied: eslint-plugin-import uses ESLint-10 compatible API');
    } else {
        const patched = content
            .replace(/sourceCode\.getTokenOrCommentAfter\(([^)]*)\)/g, 'sourceCode.getTokenAfter($1, { includeComments: true })')
            .replace(/sourceCode\.getTokenOrCommentBefore\(([^)]*)\)/g, 'sourceCode.getTokenBefore($1, { includeComments: true })');
        if (patched === content) {
            console.log('[WARN] Patch 2: unexpected call pattern, skipping');
        } else {
            fs.writeFileSync(importOrderPath, patched);
            console.log('[APPLIED] Patch 2: eslint-plugin-import order.js ESLint-10 API compat');
        }
    }
} else {
    console.log('[SKIP] Patch 2: ' + importOrderPath + ' not found');
}

// Patch 3（**正确性补丁**，2026-10-02）：playcanvas GSplat unified 投影器写回「真实源行号」
//
// ⚠️ 目标文件必须是 **build/playcanvas/src 源码树**，不是预打包的 build/playcanvas.mjs！
//    package.json 的 exports 把 ESM 入口指到 ./build/playcanvas/src/index.js，rollup 打的就是这棵树。
//    （第一次打错在 .mjs 上：运行时材质 define 仍是 8、补丁完全没进 bundle，白改一轮。）
//
// 症状：unified 通路里选中的地方不亮、别处乱闪；逐 splat 拾取拾到错的高斯。
// 根因：unified 顶点着色器只能拿到 cacheIdx = sortedIndices[order]，它是**排序槽位**
//       （投影器用 localDst = atomicAdd(&wgCount, 1u) 每帧重新分配），
//       而 app 的状态贴图（选中/锁定/删除）是按**源行号**索引的 ——
//       拿槽位当行号查状态 ⇒ 每帧给每个高斯贴一个**随机**状态。
//       （实测：框选左半边，新增黄像素却铺满全屏、质心在 0.59、只有 27.5% 落在选区内。）
// 修法：1) 投影器把 projected.splatId（源行号）写进缓存备用字 word 8；
//       2) CACHE_STRIDE 8 -> 9（缓存布局必须跟着变，否则会踩到下一个高斯的字）。
// 代价：projCache 内存 +12.5%（20M 高斯约 +80MB）。
// 配套：src/shaders/unified-shaders.ts 用 projCache[base + 8u] 当行号（改了那里就必须有本补丁）。
const rowWrite = 'projCache[base + 8u] = projected.splatId;';
const pcRoot = path.join('node_modules', 'playcanvas', 'build', 'playcanvas', 'src');
const strideFiles = [
    path.join(pcRoot, 'scene', 'gsplat-unified', 'gsplat-projector-constants.js'),
    path.join(pcRoot, 'scene', 'gsplat-unified', 'constants.js')
];
const chunkFile = path.join(pcRoot, 'scene', 'shader-lib', 'wgsl', 'chunks', 'gsplat', 'compute-gsplat-projector.js');

if (fs.existsSync(chunkFile)) {
    let body = fs.readFileSync(chunkFile, 'utf8');
    const eol = body.includes('\r\n') ? '\r\n' : '\n';
    // 先清理可能残留的 Patch 3 注释/写入行（手工撤回、部分应用、上游合入都会留下残留；
    // 不清掉的话下面的锚点会因为"#endif 与 sortKeys 之间夹了注释"而失配 —— 踩过一次）。
    const stray = /^\s*\/\/\s*SplatRoom patch 3|^\s*\/\/\s*(Write the true source row id|can index row-addressed data)/;
    const cleaned = body.split(/\r?\n/).filter(l => !stray.test(l)).join(eol);
    if (cleaned !== body) {
        body = cleaned;
        fs.writeFileSync(chunkFile, body);
        console.log('[INFO] Patch 3: removed stale comment/injection lines before re-applying');
    }
    if (body.includes(rowWrite)) {
        console.log('[OK] Patch 3 already applied: splat row id -> projCache word 8, CACHE_STRIDE = 9');
    } else {
        // 锚点：投影器 compute 里那一行 sortKeys 写入（实测全文件唯一）
        const anchorRe = /(\t+)(sortKeys\[dst\] = sortKey;)/;
        const m = body.match(anchorRe);
        if (!m) {
            console.log('[FAIL] Patch 3: projector chunk anchor (sortKeys[dst] = sortKey;) not found - selection highlight will be WRONG');
            process.exitCode = 1;
        } else {
            const indent = m[1];
            const inject = [
                indent + '// SplatRoom patch 3: cacheIdx is a per-frame atomic sort slot, not the splat row.',
                indent + '// Write the true source row id into the spare cache word so the vertex shader',
                indent + '// can index row-addressed data (selection state, pick id) correctly.',
                indent + rowWrite,
                indent + '$2'
            ].join(eol);
            body = body.replace(anchorRe, inject);
            fs.writeFileSync(chunkFile, body);
            console.log('[APPLIED] Patch 3a: projCache word 8 = splat row id (compute-gsplat-projector.js)');
        }
    }
    // 常量：两个文件都要改（同一个缓存布局，必须一致）
    for (const f of strideFiles) {
        if (!fs.existsSync(f)) {
            console.log('[WARN] Patch 3b: ' + f + ' not found');
            continue;
        }
        const c = fs.readFileSync(f, 'utf8');
        if (c.includes('const CACHE_STRIDE = 9;')) {
            console.log('[OK] Patch 3b already applied: ' + path.basename(f) + ' CACHE_STRIDE = 9');
        } else if (c.includes('const CACHE_STRIDE = 8;')) {
            fs.writeFileSync(f, c.replace('const CACHE_STRIDE = 8;', 'const CACHE_STRIDE = 9;'));
            console.log('[APPLIED] Patch 3b: ' + path.basename(f) + ' CACHE_STRIDE 8 -> 9');
        } else {
            console.log('[FAIL] Patch 3b: ' + path.basename(f) + ' has no CACHE_STRIDE = 8 - layout mismatch!');
            process.exitCode = 1;
        }
    }
} else {
    console.log('[SKIP] Patch 3: ' + chunkFile + ' not found');
}

console.log('[SplatRoom] Patches complete.');
