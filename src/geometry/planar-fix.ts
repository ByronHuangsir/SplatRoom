import { GSplatData, Mat4, Quat, Vec3 } from 'playcanvas';

import { Splat } from '../splat';
import { State } from '../splat-state';
import {
    Plane, pointToPlaneDistance, projectToBasis, basisToLocal,
    polygonBounds
} from './plane-fit';
import { quatToRotationMatrix, computeCovariance, eigenDecompSym3x3 } from './surface-analyzer';

export interface PlanarFixParams {
    /** 0..1 — how strongly uneven splats are pressed onto the plane. */
    flattenStrength: number;
    /** Relative density of hole-fill splats (0.5 sparse .. 2 dense). */
    fillDensity: number;
    /** Remove detected isolated floaters instead of just flattening them. */
    removeFloaters: boolean;
    // Color (RGB euclidean) distance under which a splat is "close to the
    //  plane's majority color". Protruding + color-near splats are flattened;
    //  protruding + color-far splats are treated as real surface detail.
    colorTolerance: number;
    /** Opacity below this is considered "transparent" and flattened. */
    transparency: number;
}

/** Parameters for Level 2 planar fix — edge smoothing + scatter cleanup. */
export interface PlanarFixLevel2Params {
    // 0.1..1.0 — scale reduction factor for edge Gaussian scale (s0/s1/s2).
    //  0.5 = edge Gaussians become half the size.
    edgeRadiusScale: number;
    // 0..1 — fraction of slab half-extent to define "edge zone".  Gaussians
    //  with |pu| > halfU * edgeZoneFrac or |pv| > halfV * edgeZoneFrac
    //  are considered edge Gaussians.
    edgeZoneFrac: number;
    /** Whether to remove scattered (isolated) Gaussians. */
    removeScatter: boolean;
    /** Gaussians with fewer than minNeighbors within scatterRadius are removed. */
    scatterRadius: number;
    /** Minimum neighbour count to survive scatter cleanup. */
    minNeighbors: number;
}

/**
 * A planar-fix session is now defined by an oriented BOX rather than points.
 *
 * The box's two largest faces are the **base face** (green, the reference
 * plane we iron onto) and the **limit face** (red, the slab cap). The box's
 * local +Y axis is the slab normal `n`. Everything is stored in **splat-local**
 * space so the math matches the GSplatData x/y/z columns.
 *
 *  - `plane.origin`  = base-face center (splat-local)
 *  - `plane.normal`  = slab normal (box +Y)
 *  - `plane.u / v`   = in-plane axes (box +X / +Z)
 *  - `thickness`     = full slab thickness `T` (base -> limit distance)
 *  - `halfU / halfV` = in-plane half-extents (box X / Z half-sizes)
 *  - `backEps`       = small back tolerance so a roughly-placed base still
 *                      captures the surface that lies slightly behind it.
 */
export interface PlanarFixSession {
    plane: Plane;
    thickness: number;
    halfU: number;
    halfV: number;
    backEps: number;
}

export interface DetectResult {
    floating: Uint32Array;
    uneven: Uint32Array;
    holes: number;
    candidates: number;
}

// ---- minimal 3D spatial hash for neighbour counting / KNN ----------------
class SpatialGrid3D {
    private cell: number;
    private grid = new Map<string, number[]>();

    constructor(cellSize: number) {
        this.cell = Math.max(cellSize, 1e-6);
    }

    private key(x: number, y: number, z: number): string {
        const cx = Math.floor(x / this.cell);
        const cy = Math.floor(y / this.cell);
        const cz = Math.floor(z / this.cell);
        return `${cx},${cy},${cz}`;
    }

    insert(index: number, x: number, y: number, z: number) {
        const k = this.key(x, y, z);
        let arr = this.grid.get(k);
        if (!arr) {
            arr = []; this.grid.set(k, arr);
        }
        arr.push(index);
    }

    _x = (_i: number) => 0;
    _y = (_i: number) => 0;
    _z = (_i: number) => 0;

    /** Count splats (excluding `self`) within radius R of (x,y,z). */
    countWithin(x: number, y: number, z: number, R: number, self: number): number {
        const range = Math.ceil(R / this.cell);
        const cx = Math.floor(x / this.cell);
        const cy = Math.floor(y / this.cell);
        const cz = Math.floor(z / this.cell);
        const r2 = R * R;
        let count = 0;
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                    const arr = this.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (!arr) continue;
                    for (const idx of arr) {
                        if (idx === self) continue;
                        const ddx = x - this._x(idx);
                        const ddy = y - this._y(idx);
                        const ddz = z - this._z(idx);
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) count++;
                    }
                }
            }
        }
        return count;
    }

    /** K nearest neighbours (by index) of (x,y,z) within radius R. */
    findKNN(x: number, y: number, z: number, K: number, R: number): number[] {
        const range = Math.ceil(R / this.cell);
        const cx = Math.floor(x / this.cell);
        const cy = Math.floor(y / this.cell);
        const cz = Math.floor(z / this.cell);
        const r2 = R * R;
        const cand: { i: number; d2: number }[] = [];
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                    const arr = this.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (!arr) continue;
                    for (const idx of arr) {
                        const ddx = x - this._x(idx);
                        const ddy = y - this._y(idx);
                        const ddz = z - this._z(idx);
                        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (d2 <= r2) cand.push({ i: idx, d2 });
                    }
                }
            }
        }
        cand.sort((a, b) => a.d2 - b.d2);
        return cand.slice(0, K).map(c => c.i);
    }
}

// ---- gaussian normal + rotation helper ------------------------------------
function gaussianNormal(
    s0: number, s1: number, s2: number,
    r0: number, r1: number, r2: number, r3: number
): Vec3 {
    const R = quatToRotationMatrix([r0, r1, r2, r3]);
    const cov = computeCovariance(R, [Math.exp(s0), Math.exp(s1), Math.exp(s2)]);
    const { vectors } = eigenDecompSym3x3(cov);
    const n = new Vec3(vectors[2][0], vectors[2][1], vectors[2][2]);
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    return n.normalize();
}

function quatFromTo(from: Vec3, to: Vec3): Quat {
    const f = from.clone().normalize();
    const t = to.clone().normalize();
    const dot = Math.min(1, Math.max(-1, f.dot(t)));
    if (dot > 0.9999) return new Quat(0, 0, 0, 1);
    if (dot < -0.9999) {
        const axis = Math.abs(f.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
        const rotAxis = new Vec3().cross(axis, f).normalize();
        return new Quat().setFromAxisAngle(rotAxis, Math.PI);
    }
    const axis = new Vec3().cross(f, t).normalize();
    return new Quat().setFromAxisAngle(axis, Math.acos(dot));
}

// build a quaternion from an orthonormal right-handed basis (x, y, z)
function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
    const m = new Mat4();
    m.data[0] = x.x; m.data[1] = x.y; m.data[2] = x.z; m.data[3] = 0;
    m.data[4] = y.x; m.data[5] = y.y; m.data[6] = y.z; m.data[7] = 0;
    m.data[8] = z.x; m.data[9] = z.y; m.data[10] = z.z; m.data[11] = 0;
    m.data[12] = 0; m.data[13] = 0; m.data[14] = 0; m.data[15] = 1;
    const q = new Quat();
    q.setFromMat4(m);
    return q;
}

// ---- SH helpers (match heal-inpaint conventions) --------------------------
const SH_C0 = 0.28209479177387814;
const decodeOpacity = (v: number) => 1 / (1 + Math.exp(-v));
// linear RGB from SH DC term (standard 3DGS decoding)
const decodeColor = (dc0: number, dc1: number, dc2: number): [number, number, number] => {
    const r = Math.min(1, Math.max(0, 0.5 + SH_C0 * dc0));
    const g = Math.min(1, Math.max(0, 0.5 + SH_C0 * dc1));
    const b = Math.min(1, Math.max(0, 0.5 + SH_C0 * dc2));
    return [r, g, b];
};
const encodeOpacity = (v: number) => Math.log(Math.max(0.001, Math.min(0.999, v)) / (1 - Math.max(0.001, Math.min(0.999, v))));

interface SplatArrays {
    xs: Float32Array; ys: Float32Array; zs: Float32Array;
    s0: Float32Array; s1: Float32Array; s2: Float32Array;
    r0: Float32Array; r1: Float32Array; r2: Float32Array; r3: Float32Array;
    dc0: Float32Array; dc1: Float32Array; dc2: Float32Array;
    op: Float32Array;
    state: Uint8Array;
    sh: Float32Array[];
    numSh: number;
}

function readArrays(splat: Splat): SplatArrays {
    const sd = splat.splatData;
    const shBands = (sd as any).shBands ?? 0;
    const numCoeffs = ([0, 3, 8, 15][shBands] ?? 0);
    const sh: Float32Array[] = [];
    for (let i = 0; i < numCoeffs * 3; i++) {
        sh.push(sd.getProp(`f_rest_${i}`) as Float32Array);
    }
    return {
        xs: sd.getProp('x') as Float32Array,
        ys: sd.getProp('y') as Float32Array,
        zs: sd.getProp('z') as Float32Array,
        s0: sd.getProp('scale_0') as Float32Array,
        s1: sd.getProp('scale_1') as Float32Array,
        s2: sd.getProp('scale_2') as Float32Array,
        r0: sd.getProp('rot_0') as Float32Array,
        r1: sd.getProp('rot_1') as Float32Array,
        r2: sd.getProp('rot_2') as Float32Array,
        r3: sd.getProp('rot_3') as Float32Array,
        dc0: sd.getProp('f_dc_0') as Float32Array,
        dc1: sd.getProp('f_dc_1') as Float32Array,
        dc2: sd.getProp('f_dc_2') as Float32Array,
        op: sd.getProp('opacity') as Float32Array,
        state: sd.getProp('state') as Uint8Array,
        sh,
        numSh: numCoeffs * 3
    };
}

interface CandidateInfo {
    indices: number[];
    puv: [number, number][];
    d: number[];
    floating: boolean[];     // isolated specks (neighbour count < 2)
    transparent: boolean[];  // opacity < transparency threshold
    protruding: boolean[];   // |d| > flatEps
    colorNear: boolean[];    // color close to majority (within colorTolerance)
    flatten: boolean[];      // should be projected onto the plane
    avgScale: number;
    R: number;
}

/**
 * Identify slab candidates (inside the box) and classify each as floater /
 * transparent / protruding / color-near, then decide which to flatten.
 *
 * A candidate is flattened when it is:
 *   - an isolated floater (unless removed), or
 *   - transparent, or
 *   - protruding AND its color is close to the plane's majority color
 *     (a depth-noise speck matching the surface tone). A protruding splat with
 *     a clearly different color is kept — it is genuine surface detail.
 */
function buildCandidateInfo(arr: SplatArrays, numSplats: number, session: PlanarFixSession, params: PlanarFixParams): { info: CandidateInfo; majority: [number, number, number] } {
    const plane = session.plane;
    const T = session.thickness;
    const backEps = session.backEps;
    const halfU = session.halfU;
    const halfV = session.halfV;

    const indices: number[] = [];
    const puv: [number, number][] = [];
    const dvals: number[] = [];
    let scaleSum = 0, scaleCount = 0;

    for (let i = 0; i < numSplats; i++) {
        if ((arr.state[i] & State.deleted) !== 0) continue;
        const p = new Vec3(arr.xs[i], arr.ys[i], arr.zs[i]);
        const d = pointToPlaneDistance(p, plane);
        // slab along +n: from base (-backEps) up to limit (+T)
        if (d < -backEps || d > T) continue;
        const { pu, pv } = projectToBasis(p, plane);
        if (Math.abs(pu) > halfU || Math.abs(pv) > halfV) continue;
        indices.push(i);
        puv.push([pu, pv]);
        dvals.push(d);
        scaleSum += (Math.exp(arr.s0[i]) + Math.exp(arr.s1[i]) + Math.exp(arr.s2[i])) / 3;
        scaleCount++;
    }

    const avgScale = scaleCount > 0 ? scaleSum / scaleCount : Math.max(T * 0.1, 1e-3);
    const R = Math.max(avgScale * 3, T * 0.05);
    const grid = new SpatialGrid3D(R);
    grid._x = i => arr.xs[i];
    grid._y = i => arr.ys[i];
    grid._z = i => arr.zs[i];
    for (let i = 0; i < numSplats; i++) {
        if ((arr.state[i] & State.deleted) !== 0) continue;
        grid.insert(i, arr.xs[i], arr.ys[i], arr.zs[i]);
    }

    const flatEps = Math.max(avgScale * 0.5, T * 0.05);

    const floating: boolean[] = new Array(indices.length).fill(false);
    const transparent: boolean[] = new Array(indices.length).fill(false);
    const protruding: boolean[] = new Array(indices.length).fill(false);
    const colorNear: boolean[] = new Array(indices.length).fill(false);

    // ---- majority color: mean RGB of near-plane, opaque, non-isolated splats
    let mr = 0, mg = 0, mb = 0, mc = 0;
    for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        if (Math.abs(dvals[k]) > flatEps) continue;
        if (decodeOpacity(arr.op[i]) < params.transparency) continue;
        const neighbors = grid.countWithin(arr.xs[i], arr.ys[i], arr.zs[i], R, i);
        if (neighbors < 2) continue;
        const c = decodeColor(arr.dc0[i], arr.dc1[i], arr.dc2[i]);
        mr += c[0]; mg += c[1]; mb += c[2]; mc++;
    }
    const majority: [number, number, number] = mc > 0 ? [mr / mc, mg / mc, mb / mc] : [0.5, 0.5, 0.5];

    for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const neighbors = grid.countWithin(arr.xs[i], arr.ys[i], arr.zs[i], R, i);
        if (neighbors < 2) floating[k] = true;
        if (decodeOpacity(arr.op[i]) < params.transparency) transparent[k] = true;
        if (Math.abs(dvals[k]) > flatEps) protruding[k] = true;
        const c = decodeColor(arr.dc0[i], arr.dc1[i], arr.dc2[i]);
        const cd = Math.hypot(c[0] - majority[0], c[1] - majority[1], c[2] - majority[2]);
        if (cd < params.colorTolerance) colorNear[k] = true;
    }

    const flatten: boolean[] = new Array(indices.length).fill(false);
    for (let k = 0; k < indices.length; k++) {
        flatten[k] = floating[k] || transparent[k] || (protruding[k] && colorNear[k]);
    }

    return {
        info: { indices, puv, d: dvals, floating, transparent, protruding, colorNear, flatten, avgScale, R },
        majority
    };
}

// ---- public: detect --------------------------------------------------------
export function detectProblems(
    splat: Splat, session: PlanarFixSession, params: PlanarFixParams
): DetectResult {
    const sd = splat.splatData;
    const numSplats = sd.numSplats;
    const arr = readArrays(splat);

    const { info } = buildCandidateInfo(arr, numSplats, session, params);

    const floating: number[] = [];
    const uneven: number[] = [];
    for (let k = 0; k < info.indices.length; k++) {
        const i = info.indices[k];
        if (info.floating[k]) {
            floating.push(i);
        } else if (info.transparent[k] || (info.protruding[k] && info.colorNear[k])) {
            uneven.push(i);
        }
    }

    // holes: empty 2D cells inside the slab footprint
    const fillSpacing = Math.max(info.avgScale / Math.max(0.5, params.fillDensity), session.thickness * 0.02);
    const occ = new Set<string>();
    for (const [pu, pv] of info.puv) {
        occ.add(`${Math.floor(pu / fillSpacing)},${Math.floor(pv / fillSpacing)}`);
    }
    // footprint bounds = the box rectangle
    const b = { minX: -session.halfU, minY: -session.halfV, maxX: session.halfU, maxY: session.halfV };
    const minGX = Math.floor(b.minX / fillSpacing);
    const maxGX = Math.floor(b.maxX / fillSpacing);
    const minGY = Math.floor(b.minY / fillSpacing);
    const maxGY = Math.floor(b.maxY / fillSpacing);
    let holeCount = 0;
    for (let gx = minGX; gx <= maxGX; gx++) {
        for (let gy = minGY; gy <= maxGY; gy++) {
            const cx = (gx + 0.5) * fillSpacing;
            const cy = (gy + 0.5) * fillSpacing;
            if (cx >= -session.halfU && cx <= session.halfU && cy >= -session.halfV && cy <= session.halfV && !occ.has(`${gx},${gy}`)) holeCount++;
        }
    }

    return {
        floating: new Uint32Array(floating).sort(),
        uneven: new Uint32Array(uneven).sort(),
        holes: holeCount,
        candidates: info.indices.length
    };
}

// ---- public: apply (flatten + fill + optionally remove floaters) ----------
export function applyFix(
    splat: Splat, session: PlanarFixSession, params: PlanarFixParams
): GSplatData {
    const sd = splat.splatData;
    const numSplats = sd.numSplats;
    const arr = readArrays(splat);
    const plane = session.plane;

    const { info } = buildCandidateInfo(arr, numSplats, session, params);

    // surface splats (for hole-fill interpolation): non-floating candidates
    const surfGrid = new SpatialGrid3D(Math.max(info.avgScale, 1e-4));
    surfGrid._x = i => arr.xs[i];
    surfGrid._y = i => arr.ys[i];
    surfGrid._z = i => arr.zs[i];
    const candPos = new Int32Array(numSplats).fill(-1);
    for (let k = 0; k < info.indices.length; k++) {
        candPos[info.indices[k]] = k;
        if (!info.floating[k]) {
            const i = info.indices[k];
            surfGrid.insert(i, arr.xs[i], arr.ys[i], arr.zs[i]);
        }
    }

    // hole cells inside the box rectangle
    const fillSpacing = Math.max(info.avgScale / Math.max(0.5, params.fillDensity), session.thickness * 0.02);
    const occ = new Set<string>();
    for (const [pu, pv] of info.puv) {
        occ.add(`${Math.floor(pu / fillSpacing)},${Math.floor(pv / fillSpacing)}`);
    }
    const b = { minX: -session.halfU, minY: -session.halfV, maxX: session.halfU, maxY: session.halfV };
    const minGX = Math.floor(b.minX / fillSpacing);
    const maxGX = Math.floor(b.maxX / fillSpacing);
    const minGY = Math.floor(b.minY / fillSpacing);
    const maxGY = Math.floor(b.maxY / fillSpacing);
    const holeCenters: [number, number][] = [];
    for (let gx = minGX; gx <= maxGX; gx++) {
        for (let gy = minGY; gy <= maxGY; gy++) {
            const cx = (gx + 0.5) * fillSpacing;
            const cy = (gy + 0.5) * fillSpacing;
            if (cx >= -session.halfU && cx <= session.halfU && cy >= -session.halfV && cy <= session.halfV && !occ.has(`${gx},${gy}`)) {
                holeCenters.push([cx, cy]);
            }
        }
    }

    // Count output size
    let removeCount = 0;
    if (params.removeFloaters) {
        for (let k = 0; k < info.indices.length; k++) {
            if (info.floating[k]) removeCount++;
        }
    }
    const outCount = numSplats - removeCount + holeCenters.length;

    const oX = new Float32Array(outCount);
    const oY = new Float32Array(outCount);
    const oZ = new Float32Array(outCount);
    const oS0 = new Float32Array(outCount);
    const oS1 = new Float32Array(outCount);
    const oS2 = new Float32Array(outCount);
    const oR0 = new Float32Array(outCount);
    const oR1 = new Float32Array(outCount);
    const oR2 = new Float32Array(outCount);
    const oR3 = new Float32Array(outCount);
    const oDc0 = new Float32Array(outCount);
    const oDc1 = new Float32Array(outCount);
    const oDc2 = new Float32Array(outCount);
    const oOp = new Float32Array(outCount);
    const oState = new Uint8Array(outCount);
    const oSh: Float32Array[] = arr.sh.map(() => new Float32Array(outCount));

    // Pass 1: copy / flatten existing splats
    let w = 0;
    const strength = params.flattenStrength;
    for (let i = 0; i < numSplats; i++) {
        if ((arr.state[i] & State.deleted) !== 0) continue;

        const candK = candPos[i];
        const isCand = candK >= 0;
        const isFloater = isCand && info.floating[candK];

        if (isFloater && params.removeFloaters) continue; // remove

        let px = arr.xs[i], py = arr.ys[i], pz = arr.zs[i];
        let qx = arr.r0[i], qy = arr.r1[i], qz = arr.r2[i], qw = arr.r3[i];

        if (isCand && info.flatten[candK]) {
            // flatten: project to plane + align normal
            const p = new Vec3(px, py, pz);
            const { pu, pv, d } = projectToBasis(p, plane);
            const np = basisToLocal(pu, pv, d * (1 - strength), plane);
            px = np.x; py = np.y; pz = np.z;
            const curN = gaussianNormal(arr.s0[i], arr.s1[i], arr.s2[i], qx, qy, qz, qw);
            const qDelta = quatFromTo(curN, plane.normal);
            const oldQ = new Quat(qx, qy, qz, qw);
            const newQ = new Quat().mul2(qDelta, oldQ);
            qx = newQ.x; qy = newQ.y; qz = newQ.z; qw = newQ.w;
        }

        oX[w] = px; oY[w] = py; oZ[w] = pz;
        oS0[w] = arr.s0[i]; oS1[w] = arr.s1[i]; oS2[w] = arr.s2[i];
        oR0[w] = qx; oR1[w] = qy; oR2[w] = qz; oR3[w] = qw;
        oDc0[w] = arr.dc0[i]; oDc1[w] = arr.dc1[i]; oDc2[w] = arr.dc2[i];
        oOp[w] = arr.op[i];
        oState[w] = (arr.state[i] & ~State.selected) as number;
        for (let s = 0; s < arr.numSh; s++) oSh[s][w] = arr.sh[s][i];
        w++;
    }

    // Pass 2: hole fill
    for (const [pu, pv] of holeCenters) {
        const center = basisToLocal(pu, pv, 0, plane);
        const K = Math.min(8, Math.max(3, info.indices.length));
        const neigh = surfGrid.findKNN(center.x, center.y, center.z, K, Math.max(info.avgScale * 2, fillSpacing * 1.5));
        if (neigh.length === 0) continue;
        const wsum: { idx: number; w: number }[] = [];
        let total = 0;
        for (const idx of neigh) {
            const ddx = center.x - arr.xs[idx];
            const ddy = center.y - arr.ys[idx];
            const ddz = center.z - arr.zs[idx];
            const wgt = 1 / (ddx * ddx + ddy * ddy + ddz * ddz + 1e-8);
            wsum.push({ idx, w: wgt });
            total += wgt;
        }
        oX[w] = center.x; oY[w] = center.y; oZ[w] = center.z;
        let s0 = 0, s1 = 0, s2 = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0, d0 = 0, d1 = 0, d2 = 0, opc = 0;
        for (const { idx, w: wgt } of wsum) {
            const nw = wgt / total;
            s0 += arr.s0[idx] * nw; s1 += arr.s1[idx] * nw; s2 += arr.s2[idx] * nw;
            r0 += arr.r0[idx] * nw; r1 += arr.r1[idx] * nw; r2 += arr.r2[idx] * nw; r3 += arr.r3[idx] * nw;
            d0 += arr.dc0[idx] * nw; d1 += arr.dc1[idx] * nw; d2 += arr.dc2[idx] * nw;
            opc += decodeOpacity(arr.op[idx]) * nw;
            for (let s = 0; s < arr.numSh; s++) oSh[s][w] += arr.sh[s][idx] * nw;
        }
        oS0[w] = s0; oS1[w] = s1; oS2[w] = s2;
        const q = new Quat(r0, r1, r2, r3);
        q.normalize();
        oR0[w] = q.x; oR1[w] = q.y; oR2[w] = q.z; oR3[w] = q.w;
        oDc0[w] = d0; oDc1[w] = d1; oDc2[w] = d2;
        oOp[w] = encodeOpacity(opc);
        oState[w] = 0;
        w++;
    }

    const finalCount = w;

    const properties: any[] = [
        { type: 'float', name: 'x', storage: oX.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'y', storage: oY.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'z', storage: oZ.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: oS0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: oS1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: oS2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: oR0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: oR1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: oR2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: oR3.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: oDc0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: oDc1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: oDc2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'opacity', storage: oOp.subarray(0, finalCount), byteSize: 4 },
        { type: 'uint8', name: 'state', storage: oState.subarray(0, finalCount), byteSize: 1 }
    ];
    for (let s = 0; s < arr.numSh; s++) {
        properties.push({
            type: 'float',
            name: `f_rest_${s}`,
            storage: oSh[s].subarray(0, finalCount),
            byteSize: 4
        });
    }

    return new GSplatData([{ name: 'vertex', count: finalCount, properties }]);
}

// ==========================================================================
// Level 2 — edge smoothing + scatter cleanup
// ==========================================================================

/**
 * Read all gaussian data from an existing GSplatData (post-level-1 result).
 */
function readGSplatData(data: GSplatData): SplatArrays {
    const numSplats = data.getProp('x').length;
    const shBands = (data as any).shBands ?? 0;
    const numCoeffs = ([0, 3, 8, 15][shBands] ?? 0);
    const sh: Float32Array[] = [];
    for (let i = 0; i < numCoeffs * 3; i++) {
        sh.push(data.getProp(`f_rest_${i}`) as Float32Array);
    }

    return {
        xs: data.getProp('x') as Float32Array,
        ys: data.getProp('y') as Float32Array,
        zs: data.getProp('z') as Float32Array,
        s0: data.getProp('scale_0') as Float32Array,
        s1: data.getProp('scale_1') as Float32Array,
        s2: data.getProp('scale_2') as Float32Array,
        r0: data.getProp('rot_0') as Float32Array,
        r1: data.getProp('rot_1') as Float32Array,
        r2: data.getProp('rot_2') as Float32Array,
        r3: data.getProp('rot_3') as Float32Array,
        dc0: data.getProp('f_dc_0') as Float32Array,
        dc1: data.getProp('f_dc_1') as Float32Array,
        dc2: data.getProp('f_dc_2') as Float32Array,
        op: data.getProp('opacity') as Float32Array,
        state: data.getProp('state') as Uint8Array,
        sh,
        numSh: sh.length
    };
}

/**
 * Level 2 planar fix — edge smoothing + scatter cleanup.
 *
 * Operates on a GSplatData (typically the result of Level 1 applyFix).
 * Returns a NEW GSplatData with:
 *   - Edge Gaussians: their scale (s0/s1/s2) reduced by edgeRadiusScale
 *   - Scattered points: removed if they have fewer than minNeighbors
 *     within scatterRadius
 *
 * @param data - Input GSplatData (post-level-1)
 * @param session - The same session used in Level 1 (for slab boundary info)
 * @param params - Level 2 parameters
 */
function applyLevel2Fix(
    data: GSplatData,
    session: PlanarFixSession,
    params: PlanarFixLevel2Params
): GSplatData {
    const arr = readGSplatData(data);
    const numSplats = arr.xs.length;
    const plane = session.plane;

    // ── Step 1: identify edge Gaussians + mark for scale reduction ──
    // Gaussians whose in-plane position is near the slab boundary.
    const edgeZoneU = session.halfU * Math.min(0.99, params.edgeZoneFrac);
    const edgeZoneV = session.halfV * Math.min(0.99, params.edgeZoneFrac);
    const isEdge = new Uint8Array(numSplats);

    for (let i = 0; i < numSplats; i++) {
        if (arr.state[i] !== 0) continue;
        const p = new Vec3(arr.xs[i], arr.ys[i], arr.zs[i]);
        const { pu, pv } = projectToBasis(p, plane);
        if (Math.abs(pu) >= edgeZoneU || Math.abs(pv) >= edgeZoneV) {
            isEdge[i] = 1;
        }
    }

    // ── Step 2: scatter detection (if enabled) ──
    // Build spatial grid and count neighbours for each non-edge Gaussian.
    const isScattered = new Uint8Array(numSplats);
    if (params.removeScatter) {
        const grid = new SpatialGrid3D(params.scatterRadius * 2);
        grid._x = (i: number) => arr.xs[i];
        grid._y = (i: number) => arr.ys[i];
        grid._z = (i: number) => arr.zs[i];
        for (let i = 0; i < numSplats; i++) {
            if (arr.state[i] !== 0) continue;
            grid.insert(i, arr.xs[i], arr.ys[i], arr.zs[i]);
        }
        for (let i = 0; i < numSplats; i++) {
            if (arr.state[i] !== 0) continue;
            if (isEdge[i]) continue;  // scatter check only for non-edge (interior)
            const nbr = grid.countWithin(arr.xs[i], arr.ys[i], arr.zs[i], params.scatterRadius, i);
            if (nbr < params.minNeighbors) {
                isScattered[i] = 1;
            }
        }
    }

    // ── Step 3: compute output count ──
    let removeCount = 0;
    for (let i = 0; i < numSplats; i++) {
        if (arr.state[i] !== 0) continue;
        if (isScattered[i]) removeCount++;
    }
    const outCount = numSplats - removeCount;

    // ── Step 4: copy with modifications ──
    const oX = new Float32Array(outCount);
    const oY = new Float32Array(outCount);
    const oZ = new Float32Array(outCount);
    const oS0 = new Float32Array(outCount);
    const oS1 = new Float32Array(outCount);
    const oS2 = new Float32Array(outCount);
    const oR0 = new Float32Array(outCount);
    const oR1 = new Float32Array(outCount);
    const oR2 = new Float32Array(outCount);
    const oR3 = new Float32Array(outCount);
    const oDc0 = new Float32Array(outCount);
    const oDc1 = new Float32Array(outCount);
    const oDc2 = new Float32Array(outCount);
    const oOp = new Float32Array(outCount);
    const oState = new Uint8Array(outCount);
    const oSh: Float32Array[] = arr.sh.map(() => new Float32Array(outCount));

    let w = 0;
    const scaleMul = params.edgeRadiusScale;

    for (let i = 0; i < numSplats; i++) {
        if (arr.state[i] !== 0) continue;
        if (isScattered[i]) continue;  // remove scattered

        oX[w] = arr.xs[i];
        oY[w] = arr.ys[i];
        oZ[w] = arr.zs[i];

        if (isEdge[i]) {
            // Edge: reduce scale (radius) by edgeRadiusScale.
            // Scale values are log space (ln(σ)).  Multiplying by factor
            // means adding ln(factor) to the log-scale values.
            const logFactor = Math.log(Math.max(0.1, scaleMul));
            oS0[w] = arr.s0[i] + logFactor;
            oS1[w] = arr.s1[i] + logFactor;
            oS2[w] = arr.s2[i] + logFactor;
        } else {
            oS0[w] = arr.s0[i];
            oS1[w] = arr.s1[i];
            oS2[w] = arr.s2[i];
        }

        oR0[w] = arr.r0[i];
        oR1[w] = arr.r1[i];
        oR2[w] = arr.r2[i];
        oR3[w] = arr.r3[i];
        oDc0[w] = arr.dc0[i];
        oDc1[w] = arr.dc1[i];
        oDc2[w] = arr.dc2[i];
        oOp[w] = arr.op[i];
        oState[w] = 0;

        for (let s = 0; s < arr.numSh; s++) {
            oSh[s][w] = arr.sh[s][i];
        }

        w++;
    }

    const finalCount = w;

    const properties: any[] = [
        { type: 'float', name: 'x', storage: oX.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'y', storage: oY.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'z', storage: oZ.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: oS0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: oS1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: oS2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: oR0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: oR1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: oR2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: oR3.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: oDc0.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: oDc1.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: oDc2.subarray(0, finalCount), byteSize: 4 },
        { type: 'float', name: 'opacity', storage: oOp.subarray(0, finalCount), byteSize: 4 },
        { type: 'uint8', name: 'state', storage: oState.subarray(0, finalCount), byteSize: 1 }
    ];
    for (let s = 0; s < arr.numSh; s++) {
        properties.push({
            type: 'float',
            name: `f_rest_${s}`,
            storage: oSh[s].subarray(0, finalCount),
            byteSize: 4
        });
    }

    return new GSplatData([{ name: 'vertex', count: finalCount, properties }]);
}
