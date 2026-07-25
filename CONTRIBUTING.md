# 贡献指南

感谢您对 SplatRoom 的关注！欢迎提交 Issue、Pull Request 和建议。

## 开发环境搭建

### 环境要求

- **Node.js** >= 20.19.0
- **npm** >= 10
- 推荐使用 VS Code 编辑器

### 步骤

```sh
# 1. Fork 并克隆仓库
git clone https://github.com/<your-username>/splatroom.git
cd splatroom

# 2. 安装依赖
npm install

# 3. 启动开发服务器
npm run develop
```

浏览器打开 `http://localhost:3000`。源码修改后自动重建，刷新浏览器即可看到变更。

### 构建验证

提交前请确保构建通过：

```sh
npm run build
```

如果修改了 locale 文件，请运行：

```sh
npm run lint:locales
```

## 代码规范

### TypeScript

- 使用 TypeScript 编写所有新代码
- 遵循项目已有的 ESLint 配置（`@playcanvas/eslint-config`）
- 运行 `npm run lint` 检查代码风格

### 命名约定

- **文件名**：`kebab-case.ts`（如 `floater-removal.ts`）
- **类名**：`PascalCase`（如 `FloaterRemoval`）
- **私有属性**：`_camelCase`（如 `_highlights`）
- **常量**：`UPPER_SNAKE_CASE`（如 `QUICK_DEFAULTS`）
- **事件名**：`namespace.action`（如 `camera.inertia`、`scene.group.toggle`）

### UI 组件

- 使用 PCUI 框架（`@playcanvas/pcui`）构建界面
- 样式使用 SCSS，放在 `src/ui/scss/` 目录
- 新增面板需在 `src/ui/scss/style.scss` 中导入样式文件
- 国际化文本必须添加到 `static/locales/zh-CN.json` 和 `static/locales/en.json`
- 同时更新 `dist/static/locales/` 下的对应文件

### Shader 修改

- 调色相关 shader 代码放在 `src/shaders/splat-shader.ts`
- Vertex shader 和 Fragment shader 的调色逻辑分离
- 注意 GPU 性能影响，避免在 shader 中做过多分支判断

## 提交规范

### Commit Message 格式

```
<type>: <description>
```

**Type 类型**：
- `feat` — 新功能
- `fix` — 修复 bug
- `refactor` — 重构
- `style` — 样式调整
- `docs` — 文档
- `chore` — 构建/工具
- `i18n` — 国际化

**示例**：
```
feat: 添加 HSL 逐通道调色功能
fix: 修复 PiP 画面延迟问题
i18n: 更新摄像机面板中英文翻译
```

### Pull Request 流程

1. 从 `main` 分支创建功能分支：`git checkout -b feat/your-feature`
2. 编写代码并确保构建通过
3. 如有 UI 变更，截图说明改动效果
4. 提交 PR，描述改动内容和动机
5. 等待 Code Review

## 项目结构

```
splatroom/
├── src/
│   ├── ui/                  # UI 面板组件
│   │   ├── camera-panel.ts
│   │   ├── color-panel.ts
│   │   ├── floater-panel.ts
│   │   ├── heal-panel.ts
│   │   ├── timeline-panel.ts
│   │   ├── context-menu.ts
│   │   └── scss/            # 样式文件
│   ├── shaders/             # GPU Shader
│   │   └── splat-shader.ts
│   ├── camera.ts            # 相机系统
│   ├── controllers.ts       # 输入控制器
│   ├── editor.ts            # 编辑器主逻辑
│   ├── scene.ts             # 场景管理
│   ├── splat.ts             # 高斯泼溅数据模型
│   ├── edit-ops.ts          # 撤销/重做操作
│   ├── color-grade-file.ts  # SSCP 侧车文件
│   ├── floater-removal.ts   # 去浮云引擎
│   ├── heal-inpaint.ts      # 修补算法
│   ├── group-renderer.ts    # 多模型全局排序
│   ├── render.ts            # 视频导出
│   └── camera-preview.ts    # PiP 异步渲染
├── static/
│   ├── locales/             # 国际化文件
│   ├── images/              # 静态图片
│   └── icons/               # 图标
├── dist/                    # 构建输出
├── docs/                    # 文档
├── package.json
├── rollup.config.mjs        # 构建配置
└── electron-main.js         # Electron 主进程
```

## Issue 提交

提交 Issue 时请包含以下信息：

### Bug 报告
- **环境**：浏览器类型版本 / Electron 桌面版
- **复现步骤**：详细操作步骤
- **预期行为**：应该发生什么
- **实际行为**：实际发生了什么
- **截图/录屏**：如有请附上
- **控制台错误**：F12 开发者工具中的报错信息

### 功能建议
- **使用场景**：为什么需要这个功能
- **功能描述**：具体想要什么效果
- **参考**：其他软件中的类似功能（如有）

## 国际化贡献

### 添加新语言

1. 复制 `static/locales/en.json` 为 `<locale>.json`
2. 翻译所有键值
3. 在 `src/ui/localization.ts` 中注册新语言
4. 测试：`http://localhost:3000/?lng=<locale>`

### 翻译注意事项

- 中文使用简体中文
- 专业术语保持一致（如"高斯泼溅"、"高斯点"）
- 按钮文字简洁明了
- 如有歧义，参考已有翻译

## 许可证

提交的代码将遵循项目的 [MIT 许可证](LICENSE)。
