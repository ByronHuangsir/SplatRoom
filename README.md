# SplatRoom

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/photographer-huangsir/splatroom)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![PlayCanvas](https://img.shields.io/badge/PlayCanvas-2.20.6-EF2D5E.svg)](https://playcanvas.com/)

> 基于 [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat) 二次开发，专为 3D 高斯泼溅（Gaussian Splatting）摄影后期工作流打造。

SplatRoom 是一个免费开源的 3D 高斯泼溅检查、编辑、调色和发布工具。它既可以在浏览器中运行，也可以打包为 Windows 桌面应用，无需安装即可使用。

---

## 核心功能

### 1. 非破坏性调色系统

完整的专业级调色工作流，原始 PLY 文件始终保持只读，调色参数存储在 `.sscg` 侧车文件（JSON 格式）中。

- **基础调整**：色调、色温、饱和度、自然饱和度、亮度、对比度、高光、阴影、白场、黑场、透明度（共 11 个滑块）
- **HSL 逐通道调色**：Lightroom 风格 8 色区（红/橙/黄/绿/青/蓝/紫/品红）× 3 属性（色相/饱和度/明度），共 24 个滑块
- **A/B 对比开关**：按住对比按钮实时切换调色前后效果
- **导出烘焙**：导出时自动将调色参数烘焙到输出文件（支持 PLY / Compressed PLY / SOG）
- **滑块双击重置**：双击任意滑块恢复默认值
- **吸管白平衡**：点击画面中灰色区域自动校正白平衡
- **侧车文件自动加载**：打开 PLY 时自动检测同名 `.sscg` 文件

### 2. 去浮云工具

智能检测并移除 3D 高斯泼溅数据中的浮云噪点（孤立、半透明的高斯点）。

- **快速模式**：基于透明度 + 体积两个参数快速检测
- **精细模式**：额外支持隔离半径 + 距离参数，精细控制检测范围
- **实时预览**：检测到的浮云以红色高亮显示
- **浮云预览**：一键预览选中范围的浮云效果

### 3. 修补工具（Heal / Inpaint）

基于 KNN（K-近邻）混合算法，用周围正常高斯点填充被删除区域的颜色和属性。

- 支持球体选区范围限定
- 抖动采样避免重复纹理
- 支持 Undo / Redo

### 4. 摄像机面板

专业级摄像机控制面板，支持精确角度操作。

- **航向轴 + 俯仰轴**双轴控制：箭头按钮 15° 步进，数值框可拖拽（普通 1° 步长，Ctrl 0.05° 步长）
- **视野角（FOV）**滑块
- **惯性滑行**：松开鼠标后相机保持惯性动量并逐渐减速
- **摄像机路径调整**：可视化贝塞尔曲线路径，关键帧拖拽编辑
- **运镜模式**：线性 / 平滑切换
- **运镜速度**：路径动画播放速度
- **自动旋转**：三态拨杆（环绕 / 关闭 / 环视），手动操作自动暂停后恢复
- **旋转速度**滑块
- **屏幕角度刻度 overlay**：拖拽数值时底部显示 30° 范围刻度尺

### 5. 时间线动画系统

基于关键帧的摄像机动画编辑系统。

- **双轨道**：摄像机轨道 + 颜色轨道
- **贝塞尔曲线**：支持可拖拽的控制柄调整曲率
- **弧长重参数化**：逐段匀速，确保摄像机沿路径匀速运动
- **画中画（PiP）预览**：可拖动浮动小窗，实时预览动画中当前帧画面
- **右键菜单**：时间轴上右键添加/删除关键帧

### 6. 视频导出

支持将摄像机路径动画导出为视频。

- **路径动画视频**：沿时间线关键帧路径生成视频
- **旋转台视频**：360° 环绕场景生成视频
- **poseOverride 技术**：绕过轨道相机系统，直接设置相机位姿，消除往返误差
- **首帧强制关键帧**：解决解码器起始帧错误

### 7. 多模型拼接 Group / Link

支持多个高斯泼溅模型的组合编辑。

- **Ctrl+Click 多选**：在场景面板中多选模型
- **链锁绑定**：将多个模型编为一组，相机绕联合中心旋转
- **GroupRenderer**：组激活时合并所有高斯点到统一 GSplat 实体，实现跨模型全局深度排序
- **合并为新模型**：将编组的多个模型烘焙合并为单一 PLY 文件
- **单体编辑**：编组状态下仍可选中并变换单个模型

### 8. 还原已删除高斯点

删除操作不再永久丢失，可随时还原。

- **showDeleted 开关**：每个模型可切换显示已删除的高斯点
- **右键还原**：选中已删除点后，右键菜单"还原已删除"即可取消删除

### 9. 智能聚焦

打开模型时自动计算高斯点密集区域中心，相机聚焦到密集区域而非几何中心。

- 密度加权中心点计算
- 焦距设为密集区域中心到边缘的中间距离
- `F` 键快速聚焦选中模型

### 10. 右键菜单与快捷键

- **右键菜单**：复制 / 剪切 / 粘贴、视角预设（正面/顶面/侧面等）
- **Ctrl+C / X / V**：高斯点复制 / 剪切 / 粘贴
- **NumPad 快捷键**：5=正面, 2=底面, 1=正面, 3=侧面, 7=顶面, 0=重置

### 11. SOG 大文件导出

针对超大高斯泼溅数据（60M+ 高斯点）的 SOG 导出优化。

- **分条 WebP 编码**：当纹理 >64MB 时自动拆分为水平条带分别编码
- 自定义容器格式（魔数 + 宽高 + 条带数 + 各条带 WebP 数据）
- 兼容标准 WebP（<64MB 纹理使用标准编码）

### 12. Electron 桌面版

可打包为 Windows 便携版 exe，无需安装，双击即用。

```sh
npm run dist:win
```

输出文件：`release/SplatRoom-1.0.0.exe`

---

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 20.19.0
- npm >= 10

### 开发模式

```sh
# 1. 克隆仓库
git clone https://github.com/photographer-huangsir/splatroom.git
cd splatroom

# 2. 安装依赖
npm install

# 3. 启动开发服务器（热重载）
npm run develop
```

浏览器打开 `http://localhost:3000`，修改源码后自动重建，刷新浏览器即可看到变更。

### 构建

```sh
# 构建生产版本到 dist/
npm run build

# 打包 Windows 桌面版（便携 exe）
npm run dist:win
```

### Electron 桌面版运行

```sh
# 开发模式运行 Electron
npm run electron

# 打包为便携 exe
npm run dist:win
```

---

## 使用指南

详细的用户指南请参阅 [docs/index.md](docs/index.md)。

### 调色工作流

1. 拖入 PLY 文件加载高斯泼溅模型
2. 在左侧调色面板调整基础参数（色调、色温、饱和度等）
3. 切换到 HSL 标签页进行逐通道精细调色
4. 按住 A/B 对比按钮查看调色前后对比
5. 通过 `Scene > Save Color Grade` 保存 `.sscg` 侧车文件
6. 通过 `Scene > Export` 导出烘焙后的模型

### 去浮云工作流

1. 在左侧去浮云面板选择"快速"或"精细"模式
2. 调整检测参数（透明度阈值、体积阈值等）
3. 点击"浮云预览"查看检测到的浮云
4. 确认后点击删除

### 摄像机路径动画

1. 打开摄像机面板，开启"摄像机路径调整"
2. 在 3D 视图中调整相机位置，点击"添加关键帧"
3. 在时间线面板拖拽关键帧调整时间点
4. 拖拽贝塞尔控制柄调整路径曲率
5. 设置运镜速度
6. 通过渲染菜单导出视频

---

## 本地化

支持中文（zh-CN）和英文（en）两种语言。

### 添加新语言

1. 在 `static/locales/` 目录添加 `<locale>.json` 文件
2. 在 `src/ui/localization.ts` 中注册新语言

### 测试翻译

```
http://localhost:3000/?lng=<locale>
```

---

## 技术架构

| 组件 | 技术 |
|------|------|
| 渲染引擎 | PlayCanvas 2.20.6 |
| UI 框架 | PCUI 6.1.4 |
| 构建工具 | Rollup 4 |
| 桌面打包 | Electron 33 + Electron Builder |
| 语言 | TypeScript 6 |
| 样式 | SCSS |
| 国际化 | i18next |

### 关键模块

- `src/color-panel.ts` — 调色面板 UI（基础 + HSL）
- `src/color-grade-file.ts` — SSCP 侧车文件序列化（v4）
- `src/shaders/splat-shader.ts` — GPU 调色 Shader
- `src/floater-removal.ts` — 去浮云检测引擎
- `src/heal-inpaint.ts` — 修补填充算法
- `src/heal-tool.ts` — 修补交互工具
- `src/ui/camera-panel.ts` — 摄像机控制面板
- `src/camera.ts` — 相机系统（预设视角、poseOverride）
- `src/controllers.ts` — 控制器（惯性、自动旋转）
- `src/timeline-panel.ts` — 时间线动画面板
- `src/camera-trajectory.ts` — 摄像机轨迹采样
- `src/camera-preview.ts` — PiP 画中画异步渲染
- `src/group-renderer.ts` — 多模型全局排序渲染器
- `src/render.ts` — 视频导出渲染管线
- `src/ui/context-menu.ts` — 右键菜单组件
- `src/ui/heal-panel.ts` — 修补面板 UI
- `src/ui/floater-panel.ts` — 去浮云面板 UI

---

## 版本历史

详见 [CHANGELOG.md](CHANGELOG.md)。

---

## 贡献

欢迎提交 Issue 和 Pull Request！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE)

原始项目 Copyright (c) 2011-2026 PlayCanvas Ltd.

---

## 致谢

- [PlayCanvas](https://playcanvas.com/) — 原始 SuperSplat 项目
- [PlayCanvas Engine](https://github.com/playcanvas/engine) — WebGL 渲染引擎
- [PCUI](https://github.com/playcanvas/pcui) — UI 组件库
- 所有为开源社区贡献的开发者

---

## 相关链接

- [原始 SuperSplat](https://github.com/playcanvas/supersplat)
- [PlayCanvas 官网](https://playcanvas.com/)
- [Gaussian Splatting 论文](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)
