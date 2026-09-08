import { Asset, BoundingBox, Entity, GSplatData, Vec3 } from 'playcanvas';

/**
 * 合并工具（模块 3）— 独立元素。
 *
 * MergeModel 是"合并工作台"中的单个高斯模型：独立 Entity + gsplat 组件，
 * 完全运行在独立窗口的独立 PlayCanvas app 内（与主编辑器视窗/PiP 零共享）。
 * 模型级可编辑：选中、显隐、删除、变换（位置/旋转/缩放）、链锁联动。
 *
 * 选中状态：包围盒线框（橙色 12 条边）—— drawSelectionBoxes 在 merge-scene.ts。
 * 暗调半透明通过自定义 shader（clrScale）-->已禁用，material.update 编译会卡死加载。
 */

/** 链锁组：组内模型变换联动（移动一个，其余跟随同一增量） */
export interface MergeChain {
    id: number;
    members: MergeModel[];
}

let _chainId = 0;

export class MergeModel {
    readonly entity: Entity;
    readonly name: string;
    readonly gsplatData: GSplatData;
    /** 对应的 PlayCanvas Asset（removeModel 时需从 app.assets 移除防泄漏） */
    readonly asset: Asset;
    numSplats: number;

    /** 选中态（Ctrl+Click 多选 / 点击单选） */
    selected = false;
    /** 显隐 */
    visible = true;
    /** 链锁组（null = 未链接） */
    chain: MergeChain | null = null;

    /** 世界空间 AABB（手动计算，calcAabb 对手工 GSplatData 不可信） */
    readonly worldBound = new BoundingBox();

    /** 最近一次拾取到的采样点索引/位置（供对应点对齐选点） */
    lastPickIndex = -1;
    readonly lastPickPos = new Vec3();

    constructor(app: any, asset: Asset, name: string, gsplatData: GSplatData) {
        this.name = name;
        this.asset = asset;
        this.gsplatData = gsplatData;
        this.numSplats = gsplatData.numSplats;

        this.entity = new Entity('merge-splat');
        this.entity.addComponent('gsplat', { asset, unified: false });

        this.computeWorldAabb();
    }

    /**
     * 手动计算世界 AABB（从 x/y/z 遍历）。
     * @param sampleLimit - 采样点数上限（默认 50 万；gizmo 拖拽期间可传小值降采样，松手后精确重算）。
     */
    computeWorldAabb(sampleLimit = 500000): void {
        const xs = this.gsplatData.getProp('x') as Float32Array;
        const ys = this.gsplatData.getProp('y') as Float32Array;
        const zs = this.gsplatData.getProp('z') as Float32Array;
        const n = this.gsplatData.numSplats;
        const wm = this.entity.getWorldTransform();
        const p = new Vec3();
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const stride = Math.max(1, Math.floor(n / Math.max(1, sampleLimit)));
        for (let i = 0; i < n; i += stride) {
            p.set(xs[i], ys[i], zs[i]);
            wm.transformPoint(p, p);
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.z < minZ) minZ = p.z;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
            if (p.z > maxZ) maxZ = p.z;
        }
        this.worldBound.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        this.worldBound.halfExtents.set((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
    }

    get worldCenter(): Vec3 {
        return this.worldBound.center;
    }

    get worldRadius(): number {
        return this.worldBound.halfExtents.length();
    }

    /**
     * 采样世界空间点（供对齐/拾取）。返回紧凑的 Float32Array [x,y,z,...]。
     */
    samplePoints(maxN: number): Float32Array {
        const xs = this.gsplatData.getProp('x') as Float32Array;
        const ys = this.gsplatData.getProp('y') as Float32Array;
        const zs = this.gsplatData.getProp('z') as Float32Array;
        const n = this.gsplatData.numSplats;
        const step = Math.max(1, Math.floor(n / maxN));
        const count = Math.ceil(n / step);
        const out = new Float32Array(count * 3);
        const wm = this.entity.getWorldTransform();
        const p = new Vec3();
        let k = 0;
        for (let i = 0; i < n; i += step) {
            p.set(xs[i], ys[i], zs[i]);
            wm.transformPoint(p, p);
            out[k++] = p.x;
            out[k++] = p.y;
            out[k++] = p.z;
        }
        return out;
    }

    /** 销毁实体（从场景移除）。 */
    destroy(sceneApp: any): void {
        if (this.entity.parent) this.entity.parent.removeChild(this.entity);
        this.entity.destroy();
    }
}

/** 创建链锁组。 */
export const createChain = (members: MergeModel[]): MergeChain => {
    const chain: MergeChain = { id: ++_chainId, members: [] };
    for (const m of members) {
        if (!m.chain) {
            m.chain = chain;
            chain.members.push(m);
        }
    }
    return chain;
};

/** 从链锁组移除模型；组空则解散。 */
export const removeFromChain = (model: MergeModel): void => {
    const c = model.chain;
    if (!c) return;
    model.chain = null;
    const i = c.members.indexOf(model);
    if (i >= 0) c.members.splice(i, 1);
    if (c.members.length <= 1) {
        for (const m of c.members) m.chain = null;
        c.members = [];
    }
};

/**
 * 对链锁组应用变换增量：leader 移动后，组内其余成员按相同增量变换。
 * mode: 'translate' | 'rotate' | 'scale'
 */
export const applyChainDelta = (
    chain: MergeChain,
    leader: MergeModel,
    mode: 'translate' | 'rotate' | 'scale',
    delta: Vec3 | number,
    sampleLimit?: number
): void => {
    for (const m of chain.members) {
        if (m === leader) continue;
        if (mode === 'translate') {
            const d = delta as Vec3;
            const p = m.entity.getLocalPosition();
            m.entity.setLocalPosition(p.x + d.x, p.y + d.y, p.z + d.z);
        } else if (mode === 'rotate') {
            const r = m.entity.getLocalRotation();
            // 简化：绕世界轴增量旋转（欧拉近似，足够链锁直觉操作）
            const d = delta as Vec3;
            const e = r.getEulerAngles();
            m.entity.setLocalEulerAngles(e.x + d.x, e.y + d.y, e.z + d.z);
        } else {
            const s = delta as number;
            const sc = m.entity.getLocalScale();
            m.entity.setLocalScale(sc.x * s, sc.y * s, sc.z * s);
        }
        m.computeWorldAabb(sampleLimit);
    }
};

/** 检测软渲染（SwiftShader/llvmpipe）——headless 测试环境跳过自定义 shader 注入。 */
