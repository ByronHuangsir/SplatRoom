/**
 * CPU 版的"每像素最前表面是哪个高斯"—— unified（引擎 GPU 排序）通路的拾取实现。
 *
 * 为什么要有这一份（**量出来的结论，不是偏好**，证据见 `docs/进度存档.md` 探针 54~64）：
 *   · 这条通路上引擎的拾取那一遍用的是**它自己的拾取材质**（绘制瞬间读到的材质
 *     `matIsOurs = false`），我们的片元不参与 ⇒ 我们怎么写 id 都没用；
 *   · 它写的是 `vPickId`，来自 work buffer 的 `pcId` 流，而**资源格式里根本没有这条流**
 *     （`GSplatResource` 的流列表是写死的：splatColor / transformA / transformB / splatSH_*），
 *     引擎自带的 id 又是 `placementId`（按元素、不是按高斯）⇒ `vPickId` 恒为 0。
 *   所以那条路给不出"这个像素上是哪个高斯"；主线仍然用它（那条路是好的、而且快）。
 *
 * 这一份是纯计算（不 import playcanvas、不碰 DOM），所以将来可以直接搬进 selection-worker。
 * 语义与 GPU 那条**对齐**：
 *   · 每像素只留**最前面**的高斯（按 clip.w，即视空间深度）；
 *   · 背景像素回 `0xFFFFFFFF`（与 `Picker.readIds` 的解码一致：`>>> 0`）；
 *   · "已删除且不显示"的高斯不参与（与 pick pass 的语义一致）。
 *
 * 已知简化（写清楚，免得被当成 bug）：**用高斯中心点**判定覆盖，不铺开它的投影椭圆。
 * 对 ring 模式（"只选表面"要的是"这一片像素上最前的那些高斯"这个**集合**）足够；
 * 对超大高斯（中心在框外、却盖住框内）会少算——要更准就得铺椭圆，代价是 O(覆盖像素数)。
 */

export type CpuPickParams = {
    numSplats: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    /** 每高斯的 state 字节（bit0 选中 / bit1 锁定 / bit2 删除）；没有就传 null */
    state: Uint8Array | null;
    /** "删除但显示"时，已删除的高斯仍然参与拾取（与 pick pass 的 showDeleted 一致） */
    showDeleted: boolean;
    /** 列主序 4x4：投影矩阵 */
    projection: ArrayLike<number>;
    /** 列主序 4x4：视图矩阵 */
    view: ArrayLike<number>;
    /** 列主序 4x4：该 splat 元素的 world transform */
    worldTransform: ArrayLike<number>;
    /** 目标像素尺寸（device 像素，= scene.targetSize） */
    width: number;
    height: number;
    /** 要拾取的像素矩形（左上角 + 宽高，y 向下，与 GPU 那条路的归一化坐标一致） */
    px0: number;
    py0: number;
    pw: number;
    ph: number;
};

export type CpuPickResult = {
    /** 行主序的 id（0xFFFFFFFF = 背景） */
    ids: Uint32Array;
    /** 每像素最前表面的深度（clip.w）—— 诊断/将来给深度带用 */
    depth: Float32Array;
    /** 参与测试的高斯数（诊断） */
    tested: number;
};

export const cpuPickRect = (params: CpuPickParams): CpuPickResult => {
    const {
        numSplats, x, y, z, state, showDeleted,
        projection: p, view: v, worldTransform: m,
        width, height, px0, py0, pw, ph
    } = params;

    const count = pw * ph;
    const ids = new Uint32Array(count).fill(0xFFFFFFFF);
    const depth = new Float32Array(count).fill(Infinity);

    const x0 = px0;
    const y0 = py0;
    const x1 = px0 + pw;
    const y1 = py0 + ph;

    let tested = 0;

    for (let i = 0; i < numSplats; i++) {
        if (state && (state[i] & 4) !== 0 && !showDeleted) {
            continue;
        }

        // local -> world（列主序：m[col*4 + row]）
        const lx = x[i];
        const ly = y[i];
        const lz = z[i];
        const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

        // world -> view -> clip
        const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
        const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
        const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];

        const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
        if (!(cw > 1e-6)) {
            continue;   // 在相机后面 / 退化
        }
        tested++;

        const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
        const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
            continue;
        }

        // NDC -> 像素：x 向右、y 向下（WebGPU 渲染目标行 0 = 顶部，与 picker 的读回映射一致）
        const sx = (ndcX * 0.5 + 0.5) * width;
        const sy = (0.5 - ndcY * 0.5) * height;
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);

        // 覆盖：中心 + 一圈（3×3）。为什么要这一圈 —— 只写中心像素的话，实测"点画面正中"
        // 经常落在两个中心之间 ⇒ 返回背景（`readId` 就直接失效了），而且 ring 模式选到的集合
        // 比 GPU 那条明显偏小（21539 个像素里只有 125 个有中心）。
        // 3×3 是**成本上界**：每个高斯最多 9 次比较，2000 万点约 1.8 亿次（可接受）。
        for (let dy = -1; dy <= 1; dy++) {
            const py = iy + dy;
            if (py < y0 || py >= y1) {
                continue;
            }
            for (let dx = -1; dx <= 1; dx++) {
                const px = ix + dx;
                if (px < x0 || px >= x1) {
                    continue;
                }
                const k = (py - y0) * pw + (px - x0);
                if (cw < depth[k]) {
                    depth[k] = cw;
                    ids[k] = i;
                }
            }
        }
    }

    return { ids, depth, tested };
};

/**
 * 单点拾取（`readId` 的语义）：取"**中心离该点足够近、且最靠前**"的那个高斯。
 *
 * 为什么单独一条：GPU 那条路是把高斯的**投影椭圆**栅格化，所以画面正中的像素几乎总被某个
 * 高斯盖住；CPU 版若只按中心点写像素，实测"点画面正中"经常落在两个中心之间 ⇒ 直接返回背景。
 * 要完全对齐就得栅格化椭圆，而那是 O(覆盖像素数)：2000 万点 × 每个约 300 像素 = 几十亿次写入，
 * 不可行（见本文件头的"已知简化"）。所以单点拾取改成"半径内最近的候选里取最前的"：
 * 代价仍是 O(高斯数) 一趟扫描，语义上对"点一下就选中那个高斯"够用。
 *
 * @param params - 投影所需的数据与目标尺寸，外加 px/py/radius
 * @returns 命中的高斯 id；没有候选时返回 -1（调用方自己转成背景值 0xFFFFFFFF）
 */
export const cpuPickNearest = (
    params: Omit<CpuPickParams, 'px0' | 'py0' | 'pw' | 'ph'> & { px: number, py: number, radius?: number }
): number => {
    const {
        numSplats, x, y, z, state, showDeleted,
        projection: p, view: v, worldTransform: m, width, height
    } = params;
    const px = params.px;
    const py = params.py;
    const r = Math.max(0, params.radius ?? 6);
    const r2 = r * r;

    let bestId = -1;
    let bestDist2 = Infinity;
    let bestDepth = Infinity;

    for (let i = 0; i < numSplats; i++) {
        if (state && (state[i] & 4) !== 0 && !showDeleted) {
            continue;
        }
        const lx = x[i];
        const ly = y[i];
        const lz = z[i];
        const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

        const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
        const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
        const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];

        const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
        if (!(cw > 1e-6)) {
            continue;
        }
        const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
        const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
            continue;
        }
        const sx = (ndcX * 0.5 + 0.5) * width;
        const sy = (0.5 - ndcY * 0.5) * height;
        const ddx = sx - px;
        const ddy = sy - py;
        const dist2 = ddx * ddx + ddy * ddy;
        if (dist2 > r2) {
            continue;
        }
        // 先比"离点更近"，同距离再比"更靠前"
        if (dist2 < bestDist2 - 1e-6 || (Math.abs(dist2 - bestDist2) <= 1e-6 && cw < bestDepth)) {
            bestId = i;
            bestDist2 = dist2;
            bestDepth = cw;
        }
    }

    return bestId;
};
