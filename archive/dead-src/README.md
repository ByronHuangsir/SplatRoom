# archive/dead-src — 已归档的无引用源码（可逆）

这里存放的是**审计确认无任何引用**的模块：把它们移出 `src/` 后既不再参与编译（`tsconfig` 只 include `src/**`），
也不再进入打包（rollup 从入口做 tree-shaking，本来就不会引用）。保留文件而不是直接删除，是为了：

- 这些功能（平面修复面板、相机姿态 gizmo、动画颜色/变换轨道、裁切盒适配器、区域自动识别等）将来可能被重新接上；
- 归档而不是删除，`git log --follow` 与恢复都很简单。

## 依据（`node scripts/audit-code.mjs`）

判定标准 = 全仓库范围内**没有** `import`/动态 `import()`/`require` 引用它，且其导出的类名/函数名也没有其它文件使用：

| 归档文件 | 说明 |
|---|---|
| `animation/color-track.ts` | 时间线颜色轨道（无引用）|
| `animation/transform-tracks.ts` | 时间线变换轨道（无引用）|
| `camera-pose-gizmos.ts` | 相机位姿 gizmo（无引用）|
| `geometry/auto-region.ts` | 区域自动识别（无引用；`region-detect` 仍由语义选择使用）|
| `runtime/crop-box-adapter.ts` | 裁切盒渲染适配器（无引用）|
| `tools/planar-fix-tool.ts` | 平面修复工具（无引用；事件管线 `planarfix.apply` 仍在 `editor.ts`）|
| `ui/color.ts` | 颜色工具函数（无引用）|
| `ui/planar-fix-panel.ts` | 平面修复面板（无引用）|
| `planar-fix-box.ts` | 随 `planar-fix-tool.ts` 一起失去唯一引用者 |

> 注意：`geometry/planar-fix.ts`、`geometry/region-detect.ts`、`geometry/plane-fit.ts`、`geometry/surface-analyzer.ts`
> **仍在用**（语义选择 / 表面细化 / 熨平路径），未归档。

## 恢复方式

```powershell
git mv archive/dead-src/<相对路径> src/<相对路径>
npm run typecheck && npm run lint && npm run build
```

如果确认这些功能不再需要，可直接删除本目录（并同步清理 `src/ui/scss/` 中对应的样式，如 `planar-fix-panel.scss`
仍被 `style.scss` 引用，删代码时一并处理）。
