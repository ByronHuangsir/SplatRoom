# SplatRoom 补丁清单

## 补丁 1: splat-transform MAX_STRIPE_BYTES

- **文件**: `node_modules/@playcanvas/splat-transform/dist/index.mjs`
- **行号**: 1730
- **原始值**: `static MAX_STRIPE_BYTES = 8 * 1024 * 1024;` (8 MB)
- **修改为**: `static MAX_STRIPE_BYTES = 128 * 1024 * 1024;` (128 MB)
- **原因**: 原始 8MB 阈值会导致常见的 4096x4096 RGBA 纹理 (64MB) 触发 WPSL 分条编码，而查看器 HTML 模板不支持 WPSL 解码，导致导出的 SOG/Viewer 文件打开后是一团雾。
- **修复效果**: 128MB 阈值确保典型纹理使用标准 WebP 编码，所有外部查看器均可正常解码。
- **补丁文件**: `patches/splat-transform-index.mjs` (已打补丁的完整文件，可直接覆盖)

### 重新应用方法

每次执行 `npm install` 后，此补丁会被覆盖，需要重新应用：

```bash
# 方法 1: 直接覆盖（推荐）
cp patches/splat-transform-index.mjs node_modules/@playcanvas/splat-transform/dist/index.mjs

# 方法 2: 使用 sed 打补丁
sed -i 's/static MAX_STRIPE_BYTES = 8 \* 1024 \* 1024/static MAX_STRIPE_BYTES = 128 * 1024 * 1024/' node_modules/@playcanvas/splat-transform/dist/index.mjs
```

### 验证

```bash
grep "MAX_STRIPE_BYTES" node_modules/@playcanvas/splat-transform/dist/index.mjs
# 应输出: static MAX_STRIPE_BYTES = 128 * 1024 * 1024;
```

## 补丁 2: eslint-plugin-import ESLint 10 兼容

- **文件**: `node_modules/@playcanvas/eslint-config/node_modules/eslint-plugin-import/lib/rules/order.js`
- **原因**: ESLint 10 移除了 `sourceCode.getTokenOrCommentBefore` / `getTokenOrCommentAfter` API，而 `eslint-plugin-import@2.32`（@playcanvas/eslint-config 的传递依赖）仍在使用，导致 `npm run lint` 崩溃：
  `TypeError: sourceCode.getTokenOrCommentBefore is not a function`
- **修改**: 替换为官方推荐的 `sourceCode.getTokenBefore(node, { includeComments: true })` / `getTokenAfter` 等价调用（共 2 处）。
- **触发补丁的脚本**: `scripts/apply-patches.js`（postinstall 自动执行，幂等）

### 验证

```bash
grep -n "getTokenOrComment" node_modules/@playcanvas/eslint-config/node_modules/eslint-plugin-import/lib/rules/order.js
# 应无输出（已替换）
node node_modules/eslint/bin/eslint.js src   # 应正常运行并输出检查结果
```

### 注意

若将来升级 `@playcanvas/eslint-config` 或 `eslint-plugin-import`，此补丁可能不再需要；若补丁脚本打印 `[WARN] Patch 2: unexpected call pattern`，说明上游已修复，可删除补丁 2 的逻辑。

## 补丁 3: playcanvas GSplat unified —— 投影器写回「真实源行号」（**正确性补丁**）

- **目标文件**（⚠️ 必须是 **源码树**，不是预打包的 `build/playcanvas.mjs` —— `package.json` 的
  `exports` 把 ESM 入口指到 `./build/playcanvas/src/index.js`，rollup 打的就是这棵树。
  第一次打在 `.mjs` 上等于没打：运行时材质 define 仍是 8，白改一轮）：
  1. `.../build/playcanvas/src/scene/gsplat-unified/gsplat-projector-constants.js`
     `const CACHE_STRIDE = 8;` → `9`
  2. `.../build/playcanvas/src/scene/gsplat-unified/constants.js`（同一个缓存布局，必须一致）
     `const CACHE_STRIDE = 8;` → `9`
  3. `.../build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/compute-gsplat-projector.js`
     在 `sortKeys[dst] = sortKey;` 之前插入 `projCache[base + 8u] = projected.splatId;`
- **原因**: unified 通路的顶点着色器只能拿到 `cacheIdx = sortedIndices[order]`，它是**排序槽位**
  （投影器用 `localDst = atomicAdd(&wgCount, 1u)` 每帧重新分配），而 app 的状态贴图
  （选中/锁定/删除）是按**源行号**索引的。拿槽位当行号查状态 ⇒ **每帧给每个高斯贴一个随机状态**：
  选中的地方不亮、别处乱闪、逐 splat 拾取拾到错的高斯。
- **实测症状**（4M 真实扫描件、相机静止、框选左半边、`_tmp/probe-highlight-region2.cjs`）：
  新增的高亮黄像素铺满全屏、质心 x=0.59（在选区右边）、只有 27.5% 落在选区内；
  逐帧像素翻转 50%（描边通路 11.8%，无选区 0%）。
- **代价**: `projCache` 内存 +12.5%（20M 高斯 ≈ +80MB；该缓冲本来就按 elementCount 分配）。
- **配套代码**: `src/shaders/unified-shaders.ts` 用 `projCache[base + 8u]` 当行号查状态与当拾取 id。
  **缺了本补丁，那里读到的就是未初始化/上一帧的垃圾值。**
- **触发补丁的脚本**: `scripts/apply-patches.js`（postinstall 自动执行，幂等；锚点找不到会 `[FAIL]` 并以码 1 退出）

### 验证

```bash
node scripts/apply-patches.js
# 应输出: [OK] Patch 3 already applied ... 或 [APPLIED] Patch 3a/3b ...
grep -n "CACHE_STRIDE = " node_modules/playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-projector-constants.js
# 应输出: const CACHE_STRIDE = 9;
```

运行时确认（最可靠）：在页面里读材质的 define，必须是 9 ——

```js
// docs/verify 里的探针会用这一段；打印 define_CACHE_STRIDE
// 若仍是 8，说明补丁没进 bundle（多半又打错文件了）
```

### 回退

把两处 `CACHE_STRIDE` 改回 8、删掉那一行写入即可（但必须同时回退 `unified-shaders.ts` 里的行号读取，
否则选中状态全乱）。

## 已知失效补丁（待清理）

- **补丁 1**（splat-transform `MAX_STRIPE_BYTES`）：当前 `node_modules/@playcanvas/splat-transform/dist/index.mjs`
  里**已经找不到** `MAX_STRIPE_BYTES` 这个标识符了（上游重构）⇒ `apply-patches.js` 每次都会打印
  `[WARN] Patch 1: unexpected MAX_STRIPE_BYTES value, skipping`，属于**空跑**。需要在下次动
  splat-transform 的时候确认 SOG/Viewer 导出是否仍正常，然后决定删除补丁 1 还是重写它。
