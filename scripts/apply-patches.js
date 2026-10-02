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

// Patch 5（**正确性+性能补丁**，2026-10-02 深夜）：不需要排序时**不要**每帧重排 + 重投影
//
// 症状：薄壁模型（如 Spirula 陶钵）**相机一动不动**时部分区域逐帧闪烁（实测 el=+35 看进钵内
//       3.0~4.3%/帧、最大色差 126~238），而那些区域在 SuperSplat 里被前面的壁挡住看不见。
// 根因：`gsplat-hybrid-renderer.prepareRenderView()` **每帧无条件**调用 `sortAndProjectForCamera()`，
//       而引擎自己的簿记（manager.sortNeeded / world.version / totalActiveSplats）全是"不需要排序"：
//       实测静止时 **49.75 次排序/秒**（≈每帧一次），而 sortNeeded=false、version 恒为 1。
//       每次重排都用 `atomicAdd` **重新分配槽位**，排序键并列（实测可见点里 7.13% 与别人同键）的
//       那些高斯就按新的到达次序重新定名次 —— 薄壁前后壁因此逐帧互换。
// 修法：把 manager 的 sortNeeded 透给 prepareRenderView；为 false 且视口/版本/点数没变时，
//       直接复用上一次的 sortedIndices（此时 projCache 也没被重写，两者始终自洽）。
// 副作用（正面）：静止时省掉每帧的投影+排序 —— 20M 模型上这正是"光标不跟手"的主要开销之一。
const hybridPath = path.join(pcRoot, 'scene', 'gsplat-unified', 'gsplat-hybrid-renderer.js');
const managerPath = path.join(pcRoot, 'scene', 'gsplat-unified', 'gsplat-manager.js');
const srMarker = 'SplatRoom patch 5';

// ⚠️ 默认**关闭**：本补丁确实修好了闪烁（实测 el=+35 看进钵内：49.75 次排序/秒 → 0、
//    逐帧像素变化 3.0~4.3%（maxΔ 126~238）→ **0%，逐位相同**），但会让
//    `verify-selection-overlay` / `verify-edit-grade-crop` / `verify-effects` 三个套件变红
//    （症状：小模型只剩 3.7~4.9% 亮、效果"0 px changed" ⇒ 导入后某些帧该排未排，间接绘制参数陈旧）。
//    已排除是①着色器改动的责任（卸掉本补丁后三个套件立刻恢复 0 失败）。
//    下一步加固方向：复用条件再加"上一次排序用的就是**同一个 worldState 对象**"（身份比较）
//    + 检测到可见点数/间接参数变化时强制重排，然后再跑那三个套件；绿了才把默认值改回来。
//    打开方式：`set SPLATROOM_PATCH5=1` 后再跑 node scripts/apply-patches.js。
const patch5Enabled = process.env.SPLATROOM_PATCH5 === '1';
if (!patch5Enabled) {
    console.log('[SKIP] Patch 5: disabled by default (fixes ② but breaks 3 suites; set SPLATROOM_PATCH5=1 to try)');
} else if (fs.existsSync(hybridPath) && fs.existsSync(managerPath)) {
    let hy = fs.readFileSync(hybridPath, 'utf8');
    let mg = fs.readFileSync(managerPath, 'utf8');
    if (hy.includes(srMarker)) {
        console.log('[OK] Patch 5 already applied: reuse the last sort while sortNeeded is false');
    } else {
        // 5a: 签名多一个参数
        const sigFrom = '\tprepareRenderView(world, worldState, params) {';
        const sigTo = '\tprepareRenderView(world, worldState, params, sortNeeded = true) {';
        // 5b: 把无条件排序换成"需要才排"
        const callFrom = [
            '\t\tconst sortedIndices = this.sortAndProjectForCamera(',
            '\t\t\tworld,',
            '\t\t\tworldState,',
            '\t\t\tcameraNode,',
            '\t\t\tviewportWidth,',
            '\t\t\tviewportHeight,',
            '\t\t\tMath.max(ALPHA_VISIBILITY_THRESHOLD, params.alphaClipForward),',
            '\t\t\tfalse,',
            '\t\t\tisStereo,',
            '\t\t\tparams',
            '\t\t);',
            '\t\tif (!sortedIndices) return false;'
        ].join('\n');
        const callTo = [
            '\t\t// ' + srMarker + ': 只有真的需要排序时才重排 + 重投影。',
            '\t\t// 引擎每帧都会调用这里，而 sortAndProjectForCamera 会重新分配原子槽位；槽位次序一变，',
            '\t\t// 并列键（实测可见点的 7.13%）的名次就跟着变 —— 薄壁模型前后壁因此逐帧互换。',
            '\t\t// 复用条件必须**极窄**（第一版只比 version/count，结果导入后某些帧该排未排 ⇒ 间接绘制',
            '\t\t// 参数一直是空的、模型半透明/不出现，三个套件立刻变红）：',
            '\t\t//   (a) manager 说不需要排序，(b) 上一次排序确实做过，(c) 世界版本/激活点数没变，',
            '\t\t//   (d) 相机位姿**逐位相同** —— 位姿一变就照旧排序，所以不会漏掉任何合法的重排。',
            '\t\tconst srPos = cameraNode.getPosition();',
            '\t\tconst srFwd = cameraNode.forward;',
            '\t\tconst srSortKey = viewportWidth + "x" + viewportHeight + "|" + params.alphaClipForward + "|" +',
            '\t\t\t(isStereo ? 1 : 0) + "|" + worldState.version + "|" + worldState.totalActiveSplats + "|" +',
            '\t\t\tsrPos.x + "," + srPos.y + "," + srPos.z + "|" + srFwd.x + "," + srFwd.y + "," + srFwd.z;',
            '\t\tlet sortedIndices;',
            '\t\tif (!sortNeeded && this._srSortedIndices && worldState.sortedBefore && this._srSortKey === srSortKey) {',
            '\t\t\tsortedIndices = this._srSortedIndices;',
            '\t\t} else {',
            '\t\t\tsortedIndices = this.sortAndProjectForCamera(',
            '\t\t\t\tworld,',
            '\t\t\t\tworldState,',
            '\t\t\t\tcameraNode,',
            '\t\t\t\tviewportWidth,',
            '\t\t\t\tviewportHeight,',
            '\t\t\t\tMath.max(ALPHA_VISIBILITY_THRESHOLD, params.alphaClipForward),',
            '\t\t\t\tfalse,',
            '\t\t\t\tisStereo,',
            '\t\t\t\tparams',
            '\t\t\t);',
            '\t\t\tthis._srSortedIndices = sortedIndices;',
            '\t\t\tthis._srSortKey = srSortKey;',
            '\t\t}',
            '\t\tif (!sortedIndices) return false;'
        ].join('\n');
        const cnt = (s, needle) => s.split(needle).length - 1;
        if (cnt(hy, sigFrom) !== 1 || cnt(hy, callFrom) !== 1) {
            console.log('[FAIL] Patch 5: renderer anchors not unique (sig=' + cnt(hy, sigFrom) + ' call=' + cnt(hy, callFrom) + ') - skipping');
            process.exitCode = 1;
        } else {
            hy = hy.replace(sigFrom, sigTo).replace(callFrom, callTo);
            fs.writeFileSync(hybridPath, hy);
            console.log('[APPLIED] Patch 5a: prepareRenderView reuses the last sort when sortNeeded is false');
        }
        // 5c: manager 把 sortNeeded 透过去
        const mgFrom = '\t\t\t\tthis.renderer.prepareRenderView(this.world, lastState, this._fillRenderViewParams());';
        const mgTo = '\t\t\t\tthis.renderer.prepareRenderView(this.world, lastState, this._fillRenderViewParams(), this.sortNeeded);';
        if (cnt(mg, mgFrom) === 1) {
            fs.writeFileSync(managerPath, mg.replace(mgFrom, mgTo));
            console.log('[APPLIED] Patch 5b: manager passes sortNeeded into prepareRenderView');
        } else if (cnt(mg, 'this.sortNeeded);\n') >= 1 && mg.includes('prepareRenderView(this.world, lastState, this._fillRenderViewParams(), this.sortNeeded)')) {
            console.log('[OK] Patch 5b already applied');
        } else {
            console.log('[FAIL] Patch 5b: manager anchor not found (' + cnt(mg, mgFrom) + ') - the per-frame re-sort stays');
            process.exitCode = 1;
        }
    }
} else {
    console.log('[SKIP] Patch 5: engine files not found');
}

console.log('[SplatRoom] Patches complete.');
