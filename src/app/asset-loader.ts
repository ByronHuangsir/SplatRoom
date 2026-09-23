import { ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatData, GSplatResource } from 'playcanvas';

import { readDeviceFacts } from '../core/device-facts';
import { Events } from '../core/events';
import { type SplatAabb } from '../core/splat-aabb';
import { describeBudget, type ImportBudget } from '../core/splat-tier';
import { defaultLodIndex, loadGSplatDataAsync, validateGSplatData } from '../io/index';
import { Splat } from '../splat/splat';
import { detectGiantGreySplats, removeGiantGreySplats, shrinkGiantGreySplats } from '../splat/splat-sanitize';
import { i18n } from '../ui/localization';

/**
 * 低于这个高斯数就不弹"正在传给显卡"的进度条（打包只要几十毫秒，弹一下反而闪）。
 * 500 万是 tier A/B 的分界线（`src/core/splat-tier.ts`）。
 */
const IMPORT_GPU_NOTICE_MIN = 5_000_000;

// handles loading gsplat assets using splat-transform
class AssetLoader {
    app: AppBase;
    events: Events;

    constructor(app: AppBase, events: Events) {
        this.app = app;
        this.events = events;
    }

    // wrap in-memory GSplatData in a gsplat Asset + GSplatResource registered with
    // the engine. shared by the splat-transform load path and the PLY sequence
    // frame source, which already holds decoded GSplatData.
    //
    // `precomputedAabb`（第二十二轮）：worker 已经按引擎的算法算好了包围盒。引擎构造
    // `GSplatResource` 时会**无条件**全表扫一遍算它（6000 万行实测 2.2 s，全在主线程），
    // 所以这里在构造期间把 `calcAabb` 临时接管成"直接填这个盒子"，构造完立刻还原
    // （后面编辑/变换还要靠引擎自己重算，绝不能把 shim 留着）。
    createGSplatAsset(gsplatData: GSplatData, filename: string, precomputedAabb?: SplatAabb | null): Asset {
        const asset = new Asset(filename, 'gsplat', { url: `local-asset-${Date.now()}`, filename });
        this.app.assets.add(asset);

        let shimmed = false;
        let previousOwn: unknown;
        if (precomputedAabb) {
            // 探针可读：worker 算出来的盒子（套件拿它与引擎自己的 `calcAabb` 逐位对照 ——
            // 注意不能拿 `resource.aabb` 比：GPU bound pass 会在构造之后把它改小）
            (globalThis as any).__AABB_FROM_WORKER__ = precomputedAabb;
            const data = gsplatData as unknown as { calcAabb?: unknown };
            const hadOwn = Object.prototype.hasOwnProperty.call(data, 'calcAabb');
            previousOwn = hadOwn ? data.calcAabb : undefined;
            // 只接管"无 pred 的那次调用"（引擎构造时就是这么调的）；带 pred 的调用照旧走原实现
            data.calcAabb = function (result: any, pred?: unknown) {
                if (pred || !result?.center || !result?.halfExtents) {
                    return false;
                }
                result.center.set(...precomputedAabb.center);
                result.halfExtents.set(...precomputedAabb.halfExtents);
                return true;
            };
            shimmed = true;
            try {
                asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
            } finally {
                if (shimmed) {
                    if (previousOwn !== undefined) {
                        data.calcAabb = previousOwn;
                    } else {
                        delete data.calcAabb;
                    }
                }
            }
            return asset;
        }

        asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
        return asset;
    }

    /**
     * 让浏览器**真的画一帧**再进那段会阻塞主线程的同步循环（第十九轮）。
     *
     * 两帧是必要的：第一帧只是被排进队列，第二帧才保证上一次的 DOM/文本改动已经 paint 过。
     * 250 ms 兜底：窗口不可见时 rAF 可能永远不来（浏览器里隐藏标签页就是如此），
     * 没有兜底会把导入挂死 —— 这比"少显示一句话"严重得多。
     */
    private paintBeforeBlocking(): Promise<void> {
        const scene = this.events.invoke('scene') as { forceRender?: boolean } | undefined;
        if (scene) {
            scene.forceRender = true;   // 按需渲染模式下，不请求就不会出帧
        }
        return new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            const raf = (globalThis as any).requestAnimationFrame as undefined | ((cb: () => void) => number);
            if (typeof raf !== 'function') {
                setTimeout(done, 0);
                return;
            }
            setTimeout(done, 250);
            raf(() => raf(done));
        });
    }

    /**
     * Load a splat asset. `sanitize` controls the "giant grey splat" popup:
     * it must only fire for user-initiated imports — internal round-trips
     * (duplicate / separate / paste / document load / animation frames) would
     * otherwise pop the dialog repeatedly and interrupt editing.
     */
    async load(filename: string, fileSystem: ReadFileSystem, animationFrame?: boolean, skipReorder?: boolean, sanitize = false, contents?: Blob | null) {
        if (!animationFrame) {
            this.events.fire('startSpinner');
        }

        // 导入预算相关状态（在 try 外声明，`finally` 也要清理）
        let reduced: ImportBudget | null = null;
        let progressShown = false;

        try {
            // ask the user which LOD to load when the file contains multiple,
            // pausing the spinner while the popup is up. the editor loads a
            // single LOD, so also recommend uploading the original file when
            // publishing to superspl.at.
            const pickLod = async (lodCounts: readonly number[]) => {
                this.events.fire('stopSpinner');
                try {
                    const result = await this.events.invoke('showPopup', {
                        type: 'okcancel',
                        header: i18n.t('popup.load-options-header'),
                        message: i18n.t('popup.lod-select-message'),
                        icon: false,
                        select: {
                            // `defaultLodIndex` 现在可能返回 null（元数据里没有任何层）：
                            // 那种情况下别把字符串 "null" 塞进下拉框的初值
                            value: String(defaultLodIndex(lodCounts) ?? 0),
                            options: lodCounts.map((count, i) => ({
                                v: String(i),
                                t: `LOD ${i} (${count.toLocaleString()} ${i18n.t('popup.lod-select-splats')})`
                            }))
                        },
                        warning: {
                            text: i18n.t('popup.lod-upload-note'),
                            link: `${window.location.origin}/upload`
                        }
                    });
                    return result.action === 'ok' ? parseInt(result.value, 10) : null;
                } finally {
                    this.events.fire('startSpinner');
                }
            };

            // Skip reordering for animation frames (speed) or when explicitly requested (already ordered)
            //
            // 导入预算（2026-09-22）：模型远超本机能力时（例：1.35 亿点 / 7.02 GiB 的 PLY），
            // 在物化之前按等距抽样把行数降到设备预算，否则主线程会花几分钟把 7 GiB 列全部分配出来
            // —— 用户看到的就是"打不开"。预算之内一个点都不动。
            const fullImport = (globalThis as any).__SPLATROOM_IMPORT_FULL__ === true; // 逃生开关（探针对照用）
            const loadOptions = {
                deviceFacts: fullImport ? undefined : readDeviceFacts(this.app.graphicsDevice),
                onBudget: (budget: ImportBudget) => {
                    console.info(`[import-tier] ${describeBudget(budget)}`);
                    if (budget.reduced) {
                        reduced = budget;
                        // 抽稀要好几秒到几分钟：把不定量 spinner 换成带文字的进度条
                        this.events.fire('stopSpinner');
                        progressShown = true;
                        this.events.fire('progressStart', i18n.t('popup.import-simplify-progress'), false);
                        this.events.fire('progressUpdate', { text: describeBudget(budget) });
                    }
                },
                onDecimateProgress: (fraction: number) => {
                    this.events.fire('progressUpdate', { progress: Math.round(fraction * 100) });
                }
            };

            let result = await loadGSplatDataAsync(
                filename, fileSystem, skipReorder || animationFrame,
                animationFrame ? undefined : pickLod, loadOptions, contents
            );
            if (!result) {
                // user cancelled LOD selection
                return null;
            }
            if (progressShown) {
                this.events.fire('progressEnd');
                progressShown = false;
                if (!animationFrame) {
                    this.events.fire('startSpinner');
                }
            }
            const { gsplatData, transform } = result;
            validateGSplatData(gsplatData);

            // Sanitize "giant grey splat" layers: neutral-grey, half-transparent
            // gaussians whose scale is far beyond the scene. Some pipelines /
            // source data produce them; rendering millions explodes fill-rate ->
            // GPU timeout (black screen) -> context loss (white UI). When they
            // dominate the model we ask: shrink (keep all, clamp scale — the
            // recommended default), remove (delete them), or keep as-is.
            if (sanitize) {
                // 第二十轮：这份统计**在导入 worker 里已经算好了**（它手上就是同一批列），
                // 主线程不再逐行扫 —— 1.35 亿那档原来这一趟占主线程约 1.2 s。
                // 只有 worker 没给（回退到主线程同步加载）时才自己扫一遍。
                const report = result.giantSplat ?? detectGiantGreySplats(gsplatData);
                // 探针可读：证明了"哪条路算出来的"，也方便 A/B 比对数字
                (globalThis as any).__GIANT_REPORT__ = { ...report, source: result.giantSplat ? 'worker' : 'main' };
                if (report.removable) {
                    const popupResult = await this.events.invoke('showPopup', {
                        type: 'okcancel',
                        header: i18n.t('popup.giant-splat-header'),
                        message: i18n.t('popup.giant-splat-message', {
                            count: report.giantGrey.toLocaleString(),
                            pct: (100 * report.giantGrey / report.total).toFixed(0)
                        }),
                        icon: true,
                        warning: {
                            text: i18n.t('popup.giant-splat-warning')
                        },
                        buttons: [
                            { label: i18n.t('popup.giant-splat-shrink'), action: 'shrink' },
                            { label: i18n.t('popup.giant-splat-remove'), action: 'remove' },
                            { label: i18n.t('popup.giant-splat-keep'), action: 'keep' }
                        ]
                    });
                    if (popupResult.action === 'shrink') {
                        const shrunk = shrinkGiantGreySplats(gsplatData, report);
                        console.warn(`[splat-sanitize] shrunk ${shrunk.toLocaleString()} giant grey splats (scale clamped to sane size)`);
                    } else if (popupResult.action === 'remove') {
                        const cleaned = removeGiantGreySplats(gsplatData, report);
                        console.warn(`[splat-sanitize] removed ${cleaned.removed.toLocaleString()} giant grey splats from ${report.total.toLocaleString()}`);
                        result = { gsplatData: cleaned.data, transform };
                    }
                    // 'keep' (or dismiss) leaves the data untouched.
                }
            }

            // 第十九轮：`createGSplatAsset()` 里那一步是**引擎把列式数据打成 GPU 纹理**的同步逐行循环
            // （6000 万行实测 11.3 s，归因见 `docs/导入残留阻塞-归因与LOD时机-2026-09-22.md`），
            // 期间主线程完全不动 —— 用户看到的是一动不动的 spinner，不知道还要等多久。
            // 这里先把"正在传给显卡"画到屏幕上（两帧确保真的 paint 过，带 250 ms 兜底防止
            // 窗口不可见时 rAF 不来把导入挂死），再进那段循环。
            const numSplats = result.gsplatData?.numSplats ?? 0;
            if (numSplats >= IMPORT_GPU_NOTICE_MIN) {
                this.events.fire('stopSpinner');
                this.events.fire('progressStart', i18n.t('popup.import-gpu-prepare', { count: numSplats.toLocaleString() }), false);
                progressShown = true;
                await this.paintBeforeBlocking();
            }

            const asset = this.createGSplatAsset(result.gsplatData, filename, result.aabb ?? null);

            const splat = new Splat(asset, transform.rotation);
            if (reduced) {
                // 让 UI / 探针能看到"这个模型是按预算抽稀过的"
                const info = { from: reduced.numSplats, to: reduced.budget, tier: reduced.tier, device: reduced.device, reason: reduced.reason };
                splat.importReduction = info;
                this.events.fire('import.reduced', { filename, ...info });
                console.info(`[import-tier] 导入完成：${info.from.toLocaleString()} → ${info.to.toLocaleString()} 点（${info.reason}）`);
            }
            return splat;
        } finally {
            if (progressShown) {
                this.events.fire('progressEnd');
                progressShown = false;
            }
            if (!animationFrame) {
                this.events.fire('stopSpinner');
            }
        }
    }
}

export { AssetLoader };
