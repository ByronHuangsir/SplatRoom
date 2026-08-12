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
