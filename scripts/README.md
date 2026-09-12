# scripts — 目录说明

构建链/校验必需的工具脚本留在本目录根部，其余历次会话的一次性脚本按用途归档到 `dev-history/`。

## 根部（构建链必需，勿移动）

| 脚本 | 谁在用 |
|---|---|
| `check-locales.mjs` | `npm run lint:locales`（校验 9 个语言文件 key 与顺序一致）|
| `apply-patches.js` / `apply-patches.sh` | `npm run postinstall`（给 node_modules 打必要补丁）|
| `static-server.js` | 本地静态服务（`dist` 预览/无头验证）|

## dev-history/（归档：历史一次性脚本）

| 目录 | 内容 |
|---|---|
| `recover/` | 从回收站/备份恢复模型与源码的脚本（`rb-*.py`、`parse-recycle-bin.py` 等）|
| `gen/` | 生成测试 PLY 的脚本 |
| `smoke/` | 各功能冒烟脚本（音视频/裁切面板/时间线/手柄等）|
| `repro/` | 问题复现脚本 |
| `probe/` | 诊断探针（buffer/shader/aspect/asar 等）|
| `verify/` | 历次无头验证脚本（Puppeteer 相关）|
| `locale/` | 历次批量增删 locale key、修数据的小工具 |
| `snippets/` | 调试时摘出来的代码片段 |
| `local/` | **未入库**：本地遗留的一次性脚本（`.gitignore` 已忽略，不进仓库）|

## 现行验证入口

当前仍在维护的验证链统一放在 `docs/verify/`（见 `docs/README.md`），并可用 npm 脚本调用：

```powershell
npm run typecheck          # tsc --noEmit
npm run lint               # eslint src
npm run lint:locales       # locale key 一致性
npm run verify:diag        # 渲染诊断逻辑单元检查（无需构建/服务）
npm run verify:serve       # 起静态服务（3100）
npm run verify:toolbar     # 工具栏（需先 verify:serve）
npm run verify:selection   # 选择语义四象限/球刷
npm run verify:render      # 像素级渲染 + splatDiag
```
