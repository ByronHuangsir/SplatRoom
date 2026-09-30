/**
 * 每帧材质参数缓存（M2-3 / P2-1，2026-09-30）。
 *
 * ## 解决什么
 *
 * 两条渲染通路的 per-frame 钩子以前**无条件**调 `material.setParameter(...)`：
 *   - 主线（`Splat.onPreRender`）：~40 次/帧/元素，其中大量字面量数组
 *     （`[r,g,b,a]`、`[0,0,0,0]`、`[1,1,1,1]` …）每帧重新分配；
 *   - unified（`ensureUnifiedMaterial`）：~35 次/帧，同样带数组分配。
 * 稳态（值没变）下这些写全部是白费：引擎的 `Material.setParameter` 只是把值挂到
 * `material.parameters`（纯赋值，没有 dirty 标记），而绘制前引擎的
 * `Material.setParameters(device)` 每帧都会把 `parameters` 里**已有的**值重新推进
 * scope —— 所以"值没变就不写"在语义上完全等价。
 *
 * ## 设计
 *
 * 每个调用方（splat 元素 / unified 材质）持有一个本缓存实例：
 *   - `setScalar` / `setArray` / `setValue`（纹理等对象，引用比较）；
 *   - 数组值：缓存内部持有**持久副本**（entry.ref），比较时逐分量读；变更时把新值
 *     拷进 entry.ref 再 setParameter —— 调用方可以传临时数组，材质侧拿到的引用
 *     永远属于缓存，不会被后续帧的复用 scratch 污染；
 *   - `bind(material)`：材质对象换了（replaceData 重建、引擎 renderer 重建）→
 *     清空全部记账，第一帧全量重写；
 *   - unified 通路额外有"引擎可能原地重置 parameters"的风险（copyMaterialSettings），
 *     用 `ensureIntact(material, sentinel)` 每帧做一次哨兵校验：缓存过的一个引用
 *     不在材质上了 ⇒ 全部重写。
 */

type ArrayEntry = {
    /** 传给材质的持久数组（材质 parameters 里存的就是这个引用） */
    ref: number[];
};

class MaterialParamCache {
    private material: unknown = null;
    private readonly scalars = new Map<string, number>();
    private readonly arrays = new Map<string, ArrayEntry>();
    private readonly objects = new Map<string, unknown>();

    /** 绑定材质；换了材质对象就清空记账（返回 false 表示 material 不可用）。 */
    private bind(material: any): boolean {
        if (!material) {
            return false;
        }
        if (this.material !== material) {
            this.material = material;
            this.scalars.clear();
            this.arrays.clear();
            this.objects.clear();
        }
        return true;
    }

    /**
     * 哨兵校验（unified 通路用）：`sentinelName` 是之前经由本缓存写过的数组参数，
     * 若材质上还挂着同一个引用，说明 parameters 没被外部重置；否则清账重写。
     */
    ensureIntact(material: any, sentinelName: string): void {
        if (!this.bind(material)) {
            return;
        }
        const entry = this.arrays.get(sentinelName);
        if (entry && material.parameters?.[sentinelName]?.data !== entry.ref) {
            this.scalars.clear();
            this.arrays.clear();
            this.objects.clear();
        }
    }

    /** 数值参数：值没变就跳过。 */
    setScalar(material: any, name: string, value: number): void {
        if (!this.bind(material)) {
            return;
        }
        if (this.scalars.get(name) !== value) {
            this.scalars.set(name, value);
            material.setParameter(name, value);
        }
    }

    /** 数组参数：逐分量比较；变更时拷进缓存持有的持久数组再写（调用方可传临时数组）。 */
    setArray(material: any, name: string, values: ArrayLike<number>): void {
        if (!this.bind(material)) {
            return;
        }
        const n = values.length;
        let entry = this.arrays.get(name);
        if (!entry || entry.ref.length !== n) {
            entry = { ref: Array.from(values as ArrayLike<number>) };
            this.arrays.set(name, entry);
            material.setParameter(name, entry.ref);
            return;
        }
        let same = true;
        for (let i = 0; i < n; i++) {
            if (entry.ref[i] !== values[i]) {
                same = false;
                break;
            }
        }
        if (!same) {
            for (let i = 0; i < n; i++) {
                entry.ref[i] = values[i];
            }
            material.setParameter(name, entry.ref);
        }
    }

    /** 对象参数（纹理/缓冲等）：引用比较。 */
    setValue(material: any, name: string, value: unknown): void {
        if (!this.bind(material)) {
            return;
        }
        if (this.objects.get(name) !== value) {
            this.objects.set(name, value);
            material.setParameter(name, value);
        }
    }
}

export { MaterialParamCache };
