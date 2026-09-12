import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { semanticSelect } from '../geometry/semantic-select';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';

/**
 * 地面/水域平整逻辑（由左侧面板驱动）。
 *
 * 面板点击"地面/水域"按钮 → groundwater.setRegion → 对当前选中 splat 做
 * 语义识别 → 结果设为选区（复用现有高亮，可撤销）；"取消"→ 清除选区。
 * 检测为异步分块执行（法线估计 + 分层 + RANSAC 精化），进度经
 * groundwater.progress 上报。
 */
class GroundWaterTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene) {
        let splat: Splat | null = null;
        let previewRegion: 'ground' | 'water' = 'ground';
        let detectSeq = 0; // 防重入：只应用最新一次检测结果
        const params = {
            tolFactor: 0.01,
            ghostColorTol: 0.18
        };

        const setSplat = (s: Splat | null) => {
            splat = s;
        };
        events.on('selection.changed', setSplat);

        // 把检测结果设为选区（可撤销的 SelectOp）→ 现有高亮机制显示
        const applyPreview = async () => {
            if (!splat) return;
            const seq = ++detectSeq;
            const result = await semanticSelect(splat, {
                region: previewRegion,
                detect: { distanceTol: autoTol(splat) * params.tolFactor / 0.01 },
                water: { ghostColorTol: params.ghostColorTol },
                onProgress: (f) => {
                    events.fire('groundwater.progress', f);
                }
            });
            // 期间切换了选区/参数 → 丢弃过期结果
            if (seq !== detectSeq) return;
            const mask = new Uint8Array(result.selection.length);
            for (let i = 0; i < result.selection.length; i++) {
                mask[i] = result.selection[i] ? 255 : 0;
            }
            events.fire('edit.add', new SelectOp(splat, 'set', mask));
            events.fire('groundwater.preview', {
                region: previewRegion,
                ground: result.counts.ground,
                water: result.counts.water
            });
        };

        // 切换预览区域（面板按钮激活时触发）
        events.on('groundwater.setRegion', (r: 'ground' | 'water') => {
            previewRegion = r;
            void applyPreview();
        });

        // 取消区域 → 清除当前选区
        events.on('groundwater.clearRegion', () => {
            if (!splat) return;
            detectSeq++; // 使在途检测失效
            events.fire('edit.add', new SelectOp(splat, 'set', new Uint8Array(splat.splatData.numSplats)));
        });

        // 参数变化 → 若当前有激活区域则重跑检测
        events.on('groundwater.paramsChanged', (p: { tolFactor: number; ghostColorTol: number }) => {
            params.tolFactor = p.tolFactor;
            params.ghostColorTol = p.ghostColorTol;
            void applyPreview();
        });

        // 熨平地面（复用 semantic.flatten 历史化流程，带当前容差）
        events.on('groundwater.flatten', () => {
            if (!splat) return;
            events.fire('semantic.flatten', {
                detect: { distanceTol: autoTol(splat) * params.tolFactor / 0.01 },
                fix: {}
            });
        });

        this.activate = () => {
            const sel = events.invoke('selection') as Splat | undefined;
            splat = sel ?? null;
            scene.forceRender = true;
        };

        this.deactivate = () => {
            splat = null;
            detectSeq++;
            scene.forceRender = true;
        };
    }
}

/** 包围盒对角线（与 semantic-select 的 autoTol 一致）。 */
function autoTol(splat: Splat): number {
    const sd = splat.splatData;
    const xs = sd.getProp('x') as Float32Array;
    const ys = sd.getProp('y') as Float32Array;
    const zs = sd.getProp('z') as Float32Array;
    const n = sd.numSplats;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        if (xs[i] < minX) minX = xs[i];
        if (xs[i] > maxX) maxX = xs[i];
        if (ys[i] < minY) minY = ys[i];
        if (ys[i] > maxY) maxY = ys[i];
        if (zs[i] < minZ) minZ = zs[i];
        if (zs[i] > maxZ) maxZ = zs[i];
    }
    return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2);
}

export { GroundWaterTool };
