# 旋转时"排序错序"的结构性规避（与 SuperSplat 3.3.0 对照，2026-09-22，v3.23.38）

用户反馈：**旋转视角时依然出现排序错误，即便转得很慢**；并要求"扒一下 supersplat 3.3.0 的代码，他们的很流畅"。

## 1. 先把上游扒清楚：SuperSplat 为什么流畅

我把 `playcanvas/supersplat` 的 **v3.3.0** 源码整包拉到 `_tmp/ss330/supersplat-3.3.0`（`codeload.github.com` 的 tag 包，2.28 MB / 155 个 `.ts`），关键事实：

| 事实 | 出处 |
| --- | --- |
| 他们**不用**引擎的 CPU worker 排序器，而是自研 `ProjectedSplatRenderer`：compute 投影 + 紧凑化 + **GPU 基数排序**（`ComputeRadixSort`，indirect）+ indirect draw | `src/projected-splat-renderer.ts:152/242/1035` |
| **交互帧根本不排序**：`render()` 里 `setStochastic(this.scene.movingRender && !forPick)` —— 相机一动就切"随机透明"画法，注释写明 *1 spp stochastic-transparency renderer (opaque, depth-tested, no per-frame sort)* | `src/projected-splat-renderer.ts:402-410, 874-876` |
| 随机透明的写法：以 **概率 = alpha** 保留片元、写**不透明**、**深度测试**决定可见性；阈值不是固定网点，而是"屏幕 2×2 quad 的四个分层 + 每 splat 散列"，再额外叠一层贡献剔除与遮挡剔除 | `src/shaders/projected-splat-shader.ts:275-300` |
| 他们对随机帧做 **quad 平均 + 双线性 resolve**（`blit-shader.ts: resolveStochastic`），把采样噪声换成量化误差；capture/导出时强制走排序路径 | `src/shaders/blit-shader.ts:26-141` |
| 用户可见开关：设置面板 "stochastic alpha" = `disabled / enabled / movement / auto`（默认 auto） | `src/ui/settings-panel.ts:233-260` |

**结论：他们的流畅不是因为"排序更快"，而是运动帧干脆不依赖顺序。** 顺序追不上是物理事实（一次全量排序要 λ 毫秒），唯一的出路是让"顺序错"这件事在运动帧里不可见。

## 2. 我们这边的现状与实测

我们的通路（`src/splat/splat.ts` / `src/core/motion-opaque.ts`）本来就有"运动期不依赖顺序"的写法，但：

* 它是**硬边裁剪**（低于 alpha 下限直接丢），2026-09-21 用户看过之后说"看着太难受"，于是**默认关闭**；
* 于是默认路径是"照常 alpha 混合 + 照常排序"，而闸门 + 延迟决定了运动帧必然错序：
  `SORT_MIN_INTERVAL_MS = 200 ms`、`SORT_MOVE_DEG = 2.5°`、λ ≈ 155–163 ms、消费 ≈ 24 ms。

实测（`docs/probes/sort-lag.cjs`，20M 夹具 `test-20m-fill.ply`，**转速 0.5°/帧 ≈ 30°/s 的"很慢旋转"**，3 秒两段）：

| 指标 | 值 |
| --- | --- |
| 旋转中顺序误差 `disp`（0 = 完全正确，0.33 = 随机）| 无补偿 P50 **0.030** / P95 0.038；有补偿 P50 **0.010** / P95 0.021 |
| 停手后 `disp` | **0.00046**（度量有效性自检：正确顺序确实接近 0）|
| 排序延迟 λ | P50 **163 ms**（无补偿）/ 157.9 ms（有补偿）|
| 3 秒内的派发次数 | 39 次（两段合计）|
| 帧时间 | P50 34.5 ms / P95 77.6 ms |

也就是说：**慢转时"平均"误差已经不大（0.01–0.03），但它是"持续存在"的**——每次派发到下一次落地之间，顺序对应的是 200 ms + λ + 24 ms 之前的相机；30°/s 下就是 ~11° 的系统性错位窗口，起步那一下更明显（速度估计要 120 ms 窗口才收敛）。这正是用户"即便很慢也有错序"的来源。

## 3. 这一轮做了什么：把上游那条路补成**默认**

### 3.1 新增"随机透明"写法（并保留硬边裁剪）

着色器（GLSL + WGSL 两份，`src/shaders/splat-shader.ts` / `splat-shader-wgsl.ts`）在运动期分支里多了一条：

```glsl
if (uMotionOpaque > 0.5) {
    if (uMotionStochastic > 0.5) {
        if (alpha < srStochasticThreshold(vScreenOffset, vViewCenter.z)) discard;   // 1 spp，概率 = alpha
    } else if (alpha < uMotionAlphaClip) {
        discard;                                                                    // 旧：硬边裁剪
    }
    pcFragColor0 = vec4(finalColor, 1.0);                                           // 不透明写出，深度测试定可见性
}
```

阈值散列 `srStochasticThreshold`：**屏幕 2×2 quad 分层**（quad 内四个像素取 [0,1) 的四个分层样本）+ **视深度参与散列**（前后重叠的两个高斯拿到不相关阈值，不会退化成固定网点）+ **不含时间项**（图案逐帧不变，不随时间闪）。用 `vScreenOffset` 而不是 `gl_FragCoord`：本仓库 WGSL 版是从 GLSL 转译的，`pcPosition` 没透出，用 varying 才能两边一致。

观感上它比硬边裁剪**更接近正常混合**：覆盖率在期望上无偏（`E = α·C + (1−α)·B`），代价是细颗粒噪点，而不是"边缘变硬 + 很透明的东西变稀疏"。

### 3.2 默认改成"运动期随机透明"，并给用户三档开关

* `MotionOpaque.mode: 'off' | 'stochastic' | 'clip'`，**默认 `stochastic`**；`effectiveMode` 的优先级：`__SPLATROOM_MOTION_MODE__` → 旧开关 `__SPLATROOM_MOTION_OPAQUE__`（true ⇒ `clip`）→ 面板设置。
* 旧的 `enabled` 保留成访问器（读 = 是否开着、写 true = 切 `clip`），这样 2026-09-21 那批套件/探针**不会静默失效**（直接删字段的话 `x.enabled = true` 会变成无害的无效赋值）。
* 设置面板新增一行「运动期渲染」：**随机透明 / 硬边裁剪 / 关闭**（对应上游的 `stochastic alpha` 设置，那边是 4 档，多一个"始终"）。文案 9 个语言包全部补齐。模式**不写偏好、不进 `.ssproj`**，纯渲染期行为。

### 3.3 它为什么能"规避"错序

运动帧的可见性只由**深度测试**决定，与绘制顺序无关 ⇒ 顺序表哪怕完全是错的，画面也**逐像素不变**。这不是"误差更小"，而是"这一类误差在这一帧里不存在"。

## 4. 验证（`docs/verify/verify-motion-opaque.cjs`，12 条断言）

| 断言 | 结果 |
| --- | --- |
| 默认模式 = 随机透明（含 `events.invoke('motionRender.mode')` 通路）| PASS `stochastic` |
| 运动帧：不透明 + 深度写 + `uMotionOpaque=1` + **`uMotionStochastic=1`** | PASS |
| 设置面板那行真的落到材质（`setMode clip/off/stochastic` 三档来回）| PASS |
| 运动期停止派发排序（ON 0 次 vs OFF 7 次，同一 1.5 s 旋转）| PASS |
| 停手补一帧精确排序（回到 alpha 混合）| PASS |
| **顺序无关性（决定性判据）**：把顺序表打乱后逐像素比对 —— alpha 路径差 **36.41**，随机透明路径差 **0.00** | PASS |
| 顺序无关性：硬边裁剪路径同样 0.00（旧 A 方案没退化）| PASS |
| 逃生开关 `__SPLATROOM_MOTION_OPAQUE__ = false` 仍可关掉 | PASS |
| `__SPLATROOM_MOTION_ALPHA_CLIP__` 覆盖仍然生效 | PASS |

webgpu **12/12**；webgl2 **10/10**（后两条顺序无关性断言在 WebGL2 上按既有约定记为"本宿主量不了"：`uploadStream.upload` 对 R32U 纹理写不进去，硬写会出现 "0.00" 假绿，文档里明确标注，权威口径是 `docs/probes/motion-opaque.cjs`）。

截图（同一机位三张，供肉眼判断观感）：`_tmp/motion-shot/stochastic-motion.png`（新默认运动帧）、`_tmp/motion-shot/settled-sorted.png`（停手精确帧，参考）、`_tmp/motion-shot/clip-motion.png`（旧硬边方案）。

## 5. 诚实的边界与后续可做

1. **我没法亲眼看图**（本会话的模型不支持读图），"观感是否可接受"这条只能由用户判断；数值上能保证的是"覆盖率无偏 + 与顺序无关 + 停手即恢复精确画面"。
2. 上游还有两件我们**没做**的事：① 随机帧的 **2×2 quad 平均 + 双线性 resolve**（把采样噪点换成量化误差，观感更好）；② 运动帧的**贡献剔除 + 上一帧遮挡剔除**（更省）。这两件都能在现有 fork 里做，但都属于新的渲染 pass，工作量另计。
3. 慢转时的"顺序新鲜度"还可以再挤：把外推 horizon 从 `λ + 消费` 改成 `λ + 消费 + 期望派发间隔/2`（让顺序在"被替换前的整段寿命"里平均对齐），预计能把上面 0.010/0.021 再降一档。这一轮没做，避免和默认模式一起上、归因不清。
4. 上游是 WebGPU-only 的 compute 通路；我们两个后端共用同一套几何/材质，所以只搬了"运动帧不依赖顺序"这个**架构决策**，没有搬 compute 投影/GPU 排序（那是另一个量级的改造）。

## 6. 当天回滚：默认改回"关闭"（v3.23.39）

我把 `stochastic` 设成默认之后，用户实测反馈：**"完全不可看，啥也看不到了，全是大面积的实心盘"**。
这个反馈是对的，原因也很清楚 —— **1 spp 随机透明没有 resolve 就是不能看**：

* 每个片元按概率 = alpha 取舍后，写出的是**整个高斯的原色、不透明**。高斯内部 alpha 高的地方几乎全部通过
  ⇒ 高斯退化成一块**实心圆盘**，只有边缘那一圈还看得出抖动，软边与半透明全丢；
* 它的"无偏"只在**空间积分之后**成立（E = α·C + (1−α)·B），单像素方差不小；
* 上游能用，是因为紧接着有一道 **resolve**：把每个 2×2 quad 的四个抖动样本求平均、再在 quad 中心之间
  双线性插值（`src/shaders/blit-shader.ts:26-141` `resolveStochastic`），把采样噪声换成量化误差
  ⇒ **软边被重建出来**。他们还有贡献剔除/遮挡剔除。我们没有那道 resolve，所以这条路当前不可用。

**我上一轮的验证漏在哪：** 那 12 条断言里最关键的一条是"顺序无关性：打乱顺序表后逐像素差 0.00"——
它只证明"这一类误差不再出现在画面上"，**完全不证明画面好看**。我在报告里写了"我看不了图"，
却还是把它设成了默认，这是判断错误：**看不了图的改动不该动默认值**。这一轮：

* `MotionOpaque.mode` 默认回到 `'off'`，设置面板该行的默认值/顺序也改成「关闭 / 随机透明 / 硬边裁剪」；
* 两种运动期写法**都留着**（用户可在设置面板里自己开），代码与回归全部保留，只是不再默认生效；
* 回归改断言"默认必须是关的"（`effectiveMode='off'`、`events.invoke('motionRender.mode')='off'`、`active=false`），
  并保留"显式打开随机透明时材质确实切过去"的断言 ⇒ webgpu 12/12、webgl2 10/10。

**结论：** "旋转时看不到错序"这条收益，必须先有 resolve 才能拿到；在那之前，默认保持"照常混合 + 照常排序"
（也就是用户原来看到的样子，仍有 §2 量化的顺序滞后）。

## 7. 顺带

* 版本 3.23.38，`release\SplatRoom-3.23.38.exe`，asar / 版本字面量 / 冒烟复核见提交信息。
* 设置面板新增一行 ⇒ 9 个语言包各 +4 键（`panel.settings.motion-render{,.stochastic,.clip,.off}`）。
