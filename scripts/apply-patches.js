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
const patch5EnabledRaw = process.env.SPLATROOM_PATCH5 === '1';
if (!patch5EnabledRaw) {
    console.log('[SKIP] Patch 5: disabled by default (superseded by patch 7; set SPLATROOM_PATCH5=1 only for A/B)');
} else if (fs.existsSync(hybridPath) && fs.readFileSync(hybridPath, 'utf8').includes('SplatRoom patch 7')) {
    // patch 7 已经改了同样的两处锚点，再打 patch 5 会失配 ⇒ 直接跳过
    console.log('[SKIP] Patch 5: superseded by patch 7 (anchors overlap)');
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
            '\t\t// 参数一直是空的、模型半透明/不出现，三个套件立刻变红；第二版补了"相机位姿逐位相同"，',
            '\t\t// 仍然红 ⇒ 真正的漏洞是：prepareRenderView 拿到的 lastState 比 world.currentVersion',
            '\t\t// **慢一帧**，导入模型的过渡帧里旧 key 仍然匹配，于是复用了"空世界"算出来的次序。',
            '\t\t// 因此复用要求：(a) manager 说不需要排序，(b) 上一次排序确实做过，',
            '\t\t//   (c) **lastState 就是当前版本**（过渡帧一律重排），(d) 版本/点数/视口没变，',
            '\t\t//   (e) 相机位姿逐位相同 —— 位姿一变就照旧排序，不会漏掉任何合法重排。',
            '\t\tconst srPos = cameraNode.getPosition();',
            '\t\tconst srFwd = cameraNode.forward;',
            '\t\tconst srSortKey = viewportWidth + "x" + viewportHeight + "|" + params.alphaClipForward + "|" +',
            '\t\t\t(isStereo ? 1 : 0) + "|" + worldState.version + "|" + worldState.totalActiveSplats + "|" +',
            '\t\t\tsrPos.x + "," + srPos.y + "," + srPos.z + "|" + srFwd.x + "," + srFwd.y + "," + srFwd.z;',
            '\t\tconst srSettled = worldState.version === world.currentVersion;',
            '\t\tlet sortedIndices;',
            '\t\tif (!sortNeeded && srSettled && this._srSortedIndices && worldState.sortedBefore && this._srSortKey === srSortKey) {',
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

// Patch 6（**正确性补丁**，2026-10-02 深夜第三轮）：给排序键追加**确定性的并列决胜位**
//
// 症状：薄壁模型（Spirula 陶钵）**相机一动不动**时看进钵内的区域逐帧闪烁（实测 el=+35
//       3.0~4.3%/帧、maxΔ 126~238），而那些区域在 SuperSplat 里被前面的壁挡住看不见。
// 根因（已定案，证据见 _tmp/probe-resort-census.cjs / probe-tie-census.cjs）：
//   · 渲染器每帧都会重排 + 重投影（实测静止时 49.75 次/秒，而 manager 自己说 sortNeeded=false）；
//   · 每次重排用 atomicAdd **重新分配槽位**，而可见点里 **7.13% 的排序键并列**；
//   · GPU 基数排序是稳定排序 ⇒ 并列项保持"输入次序"=槽位次序 ⇒ 薄壁前后壁逐帧互换。
// 修法：键整体左移 SR_TIE_BITS 位后再或上源行号低位。**相对次序完全不变**（不会打乱 bin 的先后），
//       只是把并列拆成确定次序 —— 于是"每帧重排"不再改变画面。
// 代价：键上限变成 2^SR_TIE_BITS 倍，必须仍能塞进排序器的位宽。
// ⚠️ 并列只被拆开 2^SR_TIE_BITS 分之一：4 位 ⇒ 约 93.75% 的并列被确定化（残余待实测）。
// 备选路线（已试过、否决）：patch 5 跳过冗余重排虽然把闪烁打到 0，但**间接绘制的槽位是每帧顺序分配的**，
// 跳过排序会让我们的槽位被同一帧里别的 pass 覆盖 ⇒ 模型直接不画（三个套件全红）。见 patch 5 的注释。
// ⚠️ 默认**0 = 不打**（2026-10-02 用户现场："特定角度排序不正常，是碎的"）：
//    任何"改排序键"的做法都不安全 —— 第一种写法（整体左移 8 位）把深度信息推出排序器位宽 ⇒
//    排序彻底混乱；第二种写法（原地替换低 8 位）会把**远距离 bin** 里 `divider × binFrac < 256`
//    的键归并成同一个键 ⇒ 那片区域退化成"槽位次序"⇒ 特定角度看起来是碎的。
//    ⇒ ② 的闪烁改用**不碰键**的补丁 7（"没变化就不重排"）。本补丁保留仅用于 A/B 复现。
const tieBits = parseInt(process.env.SPLATROOM_TIE_BITS || '0', 10);
const tieMarker = 'SplatRoom patch 6';
const projChunk = path.join(pcRoot, 'scene', 'shader-lib', 'wgsl', 'chunks', 'gsplat', 'compute-gsplat-projector.js');

if (tieBits > 0 && fs.existsSync(projChunk)) {
    const body = fs.readFileSync(projChunk, 'utf8');
    const keyLine = '\t\tsortKey = u32(binWeights[bin].base + binWeights[bin].divider * binFrac);';
    if (body.includes(tieMarker)) {
        console.log('[OK] Patch 6 already applied: deterministic tie-break in the sort key');
    } else if (body.split(keyLine).length - 1 !== 1) {
        console.log('[FAIL] Patch 6: sortKey anchor not found - ties stay nondeterministic');
        process.exitCode = 1;
    } else {
        const replacement = [
            keyLine,
            '\t\t// ' + tieMarker + ': 追加确定性的并列决胜位（源行号低位）。',
            '\t\t// ⚠️⚠️ 必须是**原地替换低位**，绝不能整体左移！',
            '\t\t// 第一版写成了「整体左移 8 位再或上低位」：键的量级被放大 256 倍，深度信息被推出排序器',
            '\t\t// 实际排序的位宽 ⇒ 名次由低位（源行号）决定 ⇒ 排序彻底混乱、模型显示不正常。',
            '\t\t// （用户 3.23.80 现场复现；我的套件/闪烁探针都测不到，因为"错但确定"的次序同样逐帧稳定、',
            '\t\t//  同样能通过可见性阈值 —— 缺的是"与主线逐像素对照"这类**排序正确性**校验。）',
            '\t\t// 本版：只把键的**低 ' + tieBits + ' 位**换成源行号低位 —— 量级不变、bin 先后不变，',
            '\t\t// 代价是 bin 内深度分辨率下降 2^' + tieBits + ' 分之一（相对 divider≈2^16 可忽略）。',
            '\t\t// ⚠️ 本文件是 JS 模板字符串：注释里绝不能出现反引号（本轮踩过，直接把 bundle 打崩：',
            '\t\t//    ReferenceError: raw is not defined —— 反引号提前闭合了模板）。',
            '\t\tsortKey = (u32(binWeights[bin].base + binWeights[bin].divider * binFrac) & ' + (0xFFFFFFFF - ((1 << tieBits) - 1)) + 'u) | (projected.splatId & ' + ((1 << tieBits) - 1) + 'u);'
        ].join('\n');
        fs.writeFileSync(projChunk, body.replace(keyLine, replacement));
        console.log('[APPLIED] Patch 6: sort key << ' + tieBits + ' + (splatId & ' + ((1 << tieBits) - 1) + ')');
    }
} else {
    console.log('[SKIP] Patch 6: disabled (SPLATROOM_TIE_BITS=0)');
}

// Patch 7（**性能补丁**，2026-10-02 深夜第四轮）：相机与世界都没变时，跳过最贵的"投影 + 排序"两步
//
// 背景：② 定案时实测渲染器**每帧**都会重排 + 重投影（静止时 49.75 次/秒，而 manager 说 sortNeeded=false）。
//       在 20M 模型上这就是"画笔圆圈不跟手"的主因：光标事件延迟 p50 **49.1ms**、120/120 次超 33ms、
//       rAF 间隔 71.5ms（≈14fps）。
// 与 patch 5 的区别（patch 5 的教训）：**间接绘制的槽位是每帧顺序分配的**（`getIndirectDrawSlot` 的
//       `_indirectDrawNextIndex` 每帧清零），跳过分配会让我们的槽位被同一帧里别的 pass 覆盖 ⇒ 模型不画。
//       所以这里**保留**每帧的槽位获取与 `writeIndirectArgs`，只跳过 `projector.dispatch()`（投影 compute）
//       与 `gpuSorter.sortIndirect()`（基数排序）—— 两者都是 O(可见点数) 的重活，且结果在"什么都没变"时
//       与上一帧逐位相同。
// 复用条件（严格）：manager 说不需要排序 + 上一次排序确实做过 + lastState 就是当前版本 +
//       视口/alphaClip/立体/版本/激活点数/相机位姿（逐位）全部没变。任何一项变化都照旧走完整路径。
const perfMarker = 'SplatRoom patch 7';
const reuseMarker = 'SplatRoom patch 7 (reuse)';

// 默认**开启**（`SPLATROOM_PATCH7=0` 可关）：它**不碰排序键**，只是"世界与相机都没变时复用上一次的
// 排序结果"，因此不存在"键被打乱/归并"这类风险；② 的闪烁正是靠它消除（不再重排 ⇒ 并列名次不再抖）。
// 7d（连 compaction 一起跳过的深复用）已移除：实测对 20M 的每帧开销没有改善
//（瓶颈是 GPU 渲染，不是 compute），却多一份风险。
const patch7Enabled = process.env.SPLATROOM_PATCH7 !== '0';

if (!patch7Enabled) {
    console.log('[SKIP] Patch 7: disabled by default (needs an args-only pass; set SPLATROOM_PATCH7=1 for A/B)');
} else if (fs.existsSync(hybridPath) && fs.existsSync(managerPath)) {
    let hy = fs.readFileSync(hybridPath, 'utf8');
    let mg = fs.readFileSync(managerPath, 'utf8');
    if (hy.includes(perfMarker)) {
        console.log('[OK] Patch 7 already applied: skip projector + sort when nothing changed');
    } else {
        // 7a: 签名 + 复用判定（放在 prepareRenderView 里，缓存也在这里更新）
        const sigFrom = '\tprepareRenderView(world, worldState, params) {';
        const sigTo = '\tprepareRenderView(world, worldState, params, sortNeeded = true) {';
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
            '\t\t// ' + reuseMarker + ': 只有真的变了才重投影 + 重排序（见 scripts/apply-patches.js 的说明）。',
            '\t\tconst srPos = cameraNode.getPosition();',
            '\t\tconst srFwd = cameraNode.forward;',
            '\t\tconst srCam = cameraNode.camera;',
            '\t\tconst srSortKey = viewportWidth + "x" + viewportHeight + "|" + params.alphaClipForward + "|" +',
            '\t\t\t(isStereo ? 1 : 0) + "|" + worldState.version + "|" + worldState.totalActiveSplats + "|" +',
            '\t\t\tsrPos.x + "," + srPos.y + "," + srPos.z + "|" + srFwd.x + "," + srFwd.y + "," + srFwd.z + "|" +',
            '\t\t\t// ⚠️ 投影相关的一切也必须进 key：fov / near / far / 投影矩阵 / 剔除阈值。',
            '\t\t\t// 只比位姿的话，导入时应用改了 fov（相机没动）就会复用旧投影 ⇒ 模型画到别处',
            '\t\t\t// （实测：套件看的那块区域从 99.3% 彩色掉到 3.7%，而全屏 lit 仍有 28~32%）。',
            '\t\t\tsrCam.fov + "," + srCam.nearClip + "," + srCam.farClip + "|" +',
            '\t\t\t// ⚠️ **不要**把 projectionMatrix 的 16 个元素放进 key：实测它有末位抖动，',
            '\t\t\t// 会让复用几乎每帧都失效（20M 的光标延迟 15.7ms 又退回 45ms）。',
            '\t\t\t// fov/near/far 这三个标量已足够覆盖"导入时改 fov"那类变化。',
            '\t\t\tparams.minPixelSize + "," + params.minContribution + "," + (params.radialSorting ? 1 : 0);',
            '\t\tconst srReuse = !sortNeeded && !!this._srSortedIndices && !!worldState.sortedBefore &&',
            '\t\t\tworldState.version === world.currentVersion && this._srSortKey === srSortKey &&',
            '\t\t\t// ⚠️ 还要认**缓冲对象身份**：导入/格式变化/容量变化时 world.workBuffer 与',
            '\t\t\t// projector.projCache 会被重建，缓存的次序缓冲属于旧对象 ⇒ 用它绘制就是空的。',
            '\t\t\t// （补丁 7 第一版就是因为缺这一条，导入后模型完全不画、三个套件红。）',
            '\t\t\tthis._srBuffer === world.workBuffer && this._srProjCache === this.projector.projCache;',
            '\t\tconst sortedIndices = this.sortAndProjectForCamera(',
            '\t\t\tworld,',
            '\t\t\tworldState,',
            '\t\t\tcameraNode,',
            '\t\t\tviewportWidth,',
            '\t\t\tviewportHeight,',
            '\t\t\tMath.max(ALPHA_VISIBILITY_THRESHOLD, params.alphaClipForward),',
            '\t\t\tfalse,',
            '\t\t\tisStereo,',
            '\t\t\tparams,',
            '\t\t\tsrReuse',
            '\t\t);',
            '\t\tif (!sortedIndices) return false;',
            '\t\tthis._srSortedIndices = sortedIndices;',
            '\t\tthis._srSortKey = srSortKey;',
            '\t\tthis._srBuffer = world.workBuffer;',
            '\t\tthis._srProjCache = this.projector.projCache;'
        ].join('\n');
        // 7b: sortAndProjectForCamera 多一个参数 + 在重活之前短路
        const fnFrom = '\tsortAndProjectForCamera(world, worldState, cameraNode, viewportWidth, viewportHeight, alphaClip, pickMode, isStereo, params) {';
        const fnTo = '\tsortAndProjectForCamera(world, worldState, cameraNode, viewportWidth, viewportHeight, alphaClip, pickMode, isStereo, params, srReuse = false) {';
        const skipFrom = [
            '\t\tif (pickMode) {',
            '\t\t\tthis.device.submit();',
            '\t\t}',
            '\t\treturn gpuSorter.sortIndirect('
        ].join('\n');
        const skipTo = [
            '\t\tif (srReuse) {',
            '\t\t\t// ' + perfMarker + ': 投影与排序的结果与上一帧逐位相同 ⇒ 跳过这两步 O(n) 重活。',
            '\t\t\t// 绘制参数不需要在这里补写：上面那次 projector.writeIndirectArgs(...) 每帧都会跑',
            '\t\t\t// （它读的是 compaction 刚写好的 numSplatsBuffer + sortIndirectInfo），所以本帧的',
            '\t\t\t// indirectDrawSlot 一定拿到了正确的参数 —— 这正是 patch 5 缺的那一步。',
            '\t\t\treturn this._srSortedIndices;',
            '\t\t}',
            '\t\tif (pickMode) {',
            '\t\t\tthis.device.submit();',
            '\t\t}',
            '\t\treturn gpuSorter.sortIndirect('
        ].join('\n');
        const cnt = (s, n) => s.split(n).length - 1;
        // 7d: **深复用** —— 连 compaction（O(可见点数)，20M 上是每帧的大头）也跳过。
        //     ⚠️ 注入点必须是 `const projector = this.projector;` **之后**：第一版放在
        //     `_ensureGpuPipeline()` 之后、两个 const 之前 ⇒ 每帧 TDZ ReferenceError ⇒
        //     渲染被中断（表现为"又快又稳"，其实是没画东西，四个套件全红）。这是本轮的关键教训。
        //     绘制参数的来源已读清（compute-gsplat-projector-write-indirect-args.js）：
        //       count = renderCounter[0] → instanceCount = ceil(count / INSTANCE_SIZE)
        //       numSplatsBuf[0] = sortElementCountBuf[0] = count
        //     跳过 projector.dispatch() 时 renderCounter 不再被 clear ⇒ 保留上一帧的 count ✓，
        //     所以复用帧的绘制参数依然正确；槽位仍每帧重新获取（patch 5 的教训）。
        // 7d 已移除（见 patch 7 顶部说明）：深复用对 20M 无改善，只增加风险。
        const deepFrom = null;
        const dispatchFrom = '\t\tprojector.dispatch({';
        const dispatchTo = '\t\tif (!srReuse) projector.dispatch({';
        const problems = [];
        if (cnt(hy, sigFrom) !== 1) problems.push('sig=' + cnt(hy, sigFrom));
        if (cnt(hy, callFrom) !== 1) problems.push('call=' + cnt(hy, callFrom));
        if (cnt(hy, fnFrom) !== 1) problems.push('fn=' + cnt(hy, fnFrom));
        if (cnt(hy, skipFrom) !== 1) problems.push('skip=' + cnt(hy, skipFrom));
        if (cnt(hy, dispatchFrom) !== 1) problems.push('dispatch=' + cnt(hy, dispatchFrom));
        if (problems.length) {
            console.log('[FAIL] Patch 7: renderer anchors not unique (' + problems.join(' ') + ') - skipping');
            process.exitCode = 1;
        } else {
            hy = hy.replace(sigFrom, sigTo).replace(callFrom, callTo).replace(fnFrom, fnTo)
                .replace(dispatchFrom, dispatchTo).replace(skipFrom, skipTo);
            fs.writeFileSync(hybridPath, hy);
            console.log('[APPLIED] Patch 7a: prepareRenderView computes the reuse key and caches the order');
            console.log('[APPLIED] Patch 7b: projector.dispatch + radix sort are skipped on reuse');
        }
        // 7c: manager 把 sortNeeded 透过去
        const mgFrom = '\t\t\t\tthis.renderer.prepareRenderView(this.world, lastState, this._fillRenderViewParams());';
        const mgTo = '\t\t\t\tthis.renderer.prepareRenderView(this.world, lastState, this._fillRenderViewParams(), this.sortNeeded);';
        if (cnt(mg, mgFrom) === 1) {
            fs.writeFileSync(managerPath, mg.replace(mgFrom, mgTo));
            console.log('[APPLIED] Patch 7c: manager passes sortNeeded into prepareRenderView');
        } else if (mg.includes('prepareRenderView(this.world, lastState, this._fillRenderViewParams(), this.sortNeeded)')) {
            console.log('[OK] Patch 7c already applied');
        } else {
            console.log('[FAIL] Patch 7c: manager anchor not found - the per-frame work stays');
            process.exitCode = 1;
        }
    }
}

console.log('[SplatRoom] Patches complete.');
