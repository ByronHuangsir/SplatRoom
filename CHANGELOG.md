# Changelog

本文件记录 SplatRoom 的所有版本变更。

SplatRoom 基于 [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat) 二次开发，由摄影师黄Sir 维护。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [1.0.0] - 2026-07-25

SplatRoom 首个正式发布版本。基于 PlayCanvas SuperSplat v2.31.10 二次开发，新增以下全部功能：

### 新增

#### 调色系统
- 非破坏性调色系统：SSCP 侧车文件（`.sscg`），原始 PLY 只读，GPU Shader 实时调色
- 基础调色面板：色调、色温、饱和度、自然饱和度、亮度、对比度、高光、阴影、白场、黑场、透明度（11 滑块）
- HSL 逐通道调色：8 色区 × 3 属性（色相/饱和度/明度），Lightroom 风格标签页 UI
- A/B 对比开关：按住对比按钮实时切换调色前后效果
- 滑块双击重置
- 吸管白平衡工具
- 导出烘焙：调色参数导出时烘焙到 PLY / Compressed PLY / SOG
- SSCP 侧车文件自动检测与加载
- 调色开关与分组重置按钮

#### 去浮云工具
- 去浮云检测引擎：透明度、体积、隔离半径、距离四参数策略
- 快速模式（透明度 + 体积）与精细模式（全参数）
- 非参与参数变灰显示（快速模式下）
- 浮云预览功能
- 红色高亮显示检测到的浮云

#### 修补工具
- KNN 混合算法填充已删除区域
- 球体选区范围限定
- 抖动采样避免重复纹理
- Undo / Redo 支持

#### 摄像机系统
- 摄像机面板：航向轴 + 俯仰轴双轴控制（箭头 15° 步进，拖拽 1° / Ctrl 0.05° 步长）
- 视野角（FOV）滑块
- 惯性滑行：松开鼠标后保持动量并减速（阻尼 0.92）
- 预设视角：正面/底面/侧面/顶面/重置，NumPad 快捷键
- 自动旋转：三态拨杆（环绕 / 关闭 / 环视），速度可调
- 屏幕角度刻度 overlay：拖拽数值时底部 30° 刻度尺
- 智能聚焦：密度加权中心点计算，相机聚焦到高斯点密集区域

#### 时间线动画
- 双轨道系统：摄像机轨道 + 颜色轨道
- 贝塞尔曲线路径：可拖拽控制柄调整曲率
- 弧长重参数化：逐段匀速运动
- 画中画（PiP）预览：可拖动浮动小窗
- 异步独立渲染管线：sort → wait → render → restore
- 时间轴右键菜单：添加/删除关键帧
- 关键帧跳转箭头

#### 视频导出
- 摄像机路径动画视频导出
- 旋转台 360° 视频导出
- poseOverride 技术：绕过轨道相机系统，直接设置相机位姿
- 首帧强制关键帧（I-frame）

#### 多模型拼接
- Ctrl+Click 多选模型
- 链锁绑定：多模型编组，相机绕联合中心旋转
- GroupRenderer：跨模型全局高斯点深度排序
- 合并为新模型：编组烘焙为单一 PLY
- 编组状态下单体编辑支持
- 拖拽实时反馈：隐藏合并实体，显示全部编组模型

#### 还原已删除高斯点
- showDeleted 开关：每个模型可显示已删除点
- 右键"还原已删除"：取消删除标记

#### 右键菜单与快捷键
- 右键菜单：复制 / 剪切 / 粘贴 / 视角预设
- Ctrl+C / X / V 快捷键
- 右键拖拽检测（避免拖拽时弹出菜单）

#### SOG 大文件导出
- 分条 WebP 编码：纹理 >64MB 时自动拆分水平条带
- 自定义容器格式（WPSL 魔数 + 宽高 + 条带数 + 各条带 WebP）
- 兼容标准 WebP（<64MB 纹理）

#### Electron 桌面版
- Windows 便携版 exe 打包
- Electron 33 + Electron Builder
- 修复窗口关闭被 beforeunload 阻止的问题

### 优化
- 变换面板旋转轴增加 90° 快速旋转按钮
- 相机路径控制点屏幕空间固定大小
- 路径 hover 高亮 + 右键增删控制点
- 弧长逐段匀速重参数化
- 视轴分拆为朝向锥和焦距球
- 场景面板合并按钮和 Group 指示图标
- GroupRenderer 纹理泄漏修复与 dead code 清理
- 密集区域自动聚焦

### 修复
- 单色渲染 bug：调色逻辑从顶点着色器移到片段着色器
- HSL shader `anyAdjust` 检查修复
- PiP 画中画画面延迟：SMOOTH_FACTOR 帧跳跃检测重置
- 视频导出首帧与设置 0 帧不一致
- 环视模式下视频导出无画面
- Group 解绑/合并后调色失效
- GroupRenderer SH 数据合并跨 channel 访问错误
- GroupRenderer stateTex/transformTex 纹理泄漏
- Group 拖拽重影问题
- 右键菜单二级菜单叠加 bug
- `F` 键失效 + 相机距离 sceneRadius 时序 bug
- fdist 计算错误

---

---

### 开发阶段版本（SuperSplat 分支）

以下版本为 SplatRoom 开发阶段（当时仍名为 SuperSplat 增强版）的变更记录：

## [2.31.3] - 2026-07-23

### 新增
- 调色侧车文件 SSCP v2 格式
- 基础调色参数：高光、阴影、自然饱和度、对比度
- 调色烘焙：导出时自动烘焙调色参数
- File 菜单 "Save Color Grade" / "Load Color Grade"

### 修复
- SOG 导出 WebP 编码失败（60M 高斯点 WASM 堆溢出）
- 分条 WebP 编码方案实施

---

## [2.31.2] - 2026-07-20

### 新增
- 初始调色面板：色调、色温、饱和度、亮度、对比度等 10 个基础滑块
- GPU Shader 实时调色渲染

---

## 上游版本（PlayCanvas SuperSplat）

以下版本为原始 PlayCanvas SuperSplat 项目的发布记录，SplatRoom 基于 v2.31.10。

### 原始功能
- PLY / Compressed PLY / Splat / SOG 格式导入导出
- 拾取选择 / 笔刷选择 / 球体选择三种选择工具
- 平移 / 旋转 / 缩放变换 Gizmo
- 数据面板直方图分析
- 多模型合并导出
- PWA 支持
- 多语言支持
