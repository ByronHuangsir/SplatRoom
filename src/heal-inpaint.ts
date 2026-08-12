import { GSplatData } from 'playcanvas';
import { Splat } from './splat';
import { State } from './splat-state';

// ================================================================
//  Types
// ================================================================

enum HealStrategy {
    Original = 'original',
    Poisson = 'poisson',
    KNN = 'knn'
}

interface HealParams {
    strategy: HealStrategy;
    sampleRadius: number;       // neighbor search radius (world units)
    jitter: number;             // position jitter amount (0-1, relative to splat size)
    knnK: number;               // K nearest neighbors for KNN strategy
    poissonDensity: number;     // poisson disk radius for Poisson strategy (world units)
}

interface HealResult {
    elements: any[];
    count: number;
}

interface NewSplat {
    x: number; y: number; z: number;
}

// ================================================================
//  Helpers
// ================================================================

const SH_BAND_COEFFS = [0, 3, 8, 15];

// Sigmoid decode: opacity stored as logit, decode to [0,1]
const decodeOpacity = (v: number) => 1 / (1 + Math.exp(-v));
const encodeOpacity = (v: number) => {
    const clamped = Math.max(0.001, Math.min(0.999, v));
    return Math.log(clamped / (1 - clamped));
};

// Color decode: f_dc -> [0,1]
const SH_C0 = 0.28209479177387814;
const decodeColor = (v: number) => 0.5 + v * SH_C0;
const encodeColor = (v: number) => (v - 0.5) / SH_C0;

// Quaternion normalize
const quatNormalize = (q: { w: number, x: number, y: number, z: number }) => {
    const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (len > 0) {
        q.w /= len; q.x /= len; q.y /= len; q.z /= len;
    }
    return q;
};

// Simple seeded random for reproducible results
class SeededRandom {
    private seed: number;
    constructor(seed: number) {
        this.seed = seed;
    }
    next(): number {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
    range(min: number, max: number): number {
        return min + this.next() * (max - min);
    }
}

// ================================================================
//  Grid Hash for spatial neighbor search
// ================================================================

class SpatialGrid {
    private cellSize: number;
    private grid: Map<string, number[]>;

    constructor(cellSize: number) {
        this.cellSize = cellSize;
        this.grid = new Map();
    }

    private key(x: number, y: number, z: number): string {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const cz = Math.floor(z / this.cellSize);
        return `${cx},${cy},${cz}`;
    }

    insert(index: number, x: number, y: number, z: number) {
        const k = this.key(x, y, z);
        let arr = this.grid.get(k);
        if (!arr) {
            arr = [];
            this.grid.set(k, arr);
        }
        arr.push(index);
    }

    // Find K nearest neighbors within radius
    findKNN(px: number, py: number, pz: number, k: number, maxRadius: number): number[] {
        const candidates: { index: number, distSq: number }[] = [];
        const cellRange = Math.ceil(maxRadius / this.cellSize);
        const cx = Math.floor(px / this.cellSize);
        const cy = Math.floor(py / this.cellSize);
        const cz = Math.floor(pz / this.cellSize);

        for (let dx = -cellRange; dx <= cellRange; dx++) {
            for (let dy = -cellRange; dy <= cellRange; dy++) {
                for (let dz = -cellRange; dz <= cellRange; dz++) {
                    const key = `${cx + dx},${cy + dy},${cz + dz}`;
                    const arr = this.grid.get(key);
                    if (arr) {
                        for (const idx of arr) {
                            // distSq will be computed by caller using actual positions
                            candidates.push({ index: idx, distSq: 0 });
                        }
                    }
                }
            }
        }

        // We'll return all candidates and let the caller sort by distance
        return candidates.map(c => c.index);
    }

    // Find all neighbors within radius
    findInRadius(px: number, py: number, pz: number, maxRadius: number): number[] {
        const result: number[] = [];
        const cellRange = Math.ceil(maxRadius / this.cellSize);
        const cx = Math.floor(px / this.cellSize);
        const cy = Math.floor(py / this.cellSize);
        const cz = Math.floor(pz / this.cellSize);

        for (let dx = -cellRange; dx <= cellRange; dx++) {
            for (let dy = -cellRange; dy <= cellRange; dy++) {
                for (let dz = -cellRange; dz <= cellRange; dz++) {
                    const key = `${cx + dx},${cy + dy},${cz + dz}`;
                    const arr = this.grid.get(key);
                    if (arr) {
                        for (const idx of arr) {
                            result.push(idx);
                        }
                    }
                }
            }
        }

        return result;
    }
}

// ================================================================
//  Main inpainting function
// ================================================================

function healInpaint(splat: Splat, selectedIndices: number[], params: HealParams): HealResult {
    const splatData = splat.splatData;
    const shBands = (splatData as any).shBands ?? 0;
    const numCoeffs = SH_BAND_COEFFS[shBands] ?? 0;
    const totalShProps = numCoeffs * 3;

    // Get property arrays from source splat
    const getX = splatData.getProp('x') as Float32Array;
    const getY = splatData.getProp('y') as Float32Array;
    const getZ = splatData.getProp('z') as Float32Array;
    const getScale0 = splatData.getProp('scale_0') as Float32Array;
    const getScale1 = splatData.getProp('scale_1') as Float32Array;
    const getScale2 = splatData.getProp('scale_2') as Float32Array;
    const getRot0 = splatData.getProp('rot_0') as Float32Array;
    const getRot1 = splatData.getProp('rot_1') as Float32Array;
    const getRot2 = splatData.getProp('rot_2') as Float32Array;
    const getRot3 = splatData.getProp('rot_3') as Float32Array;
    const getFdc0 = splatData.getProp('f_dc_0') as Float32Array;
    const getFdc1 = splatData.getProp('f_dc_1') as Float32Array;
    const getFdc2 = splatData.getProp('f_dc_2') as Float32Array;
    const getOpacity = splatData.getProp('opacity') as Float32Array;
    const state = splatData.getProp('state') as Uint8Array;

    // Get SH arrays
    const shArrays: Float32Array[] = [];
    for (let i = 0; i < totalShProps; i++) {
        shArrays.push(splatData.getProp(`f_rest_${i}`) as Float32Array);
    }

    const totalSplats = splatData.numSplats;
    const selectedSet = new Set(selectedIndices);

    // ---- Step 1: Build neighbor grid (non-selected, non-deleted splats) ----
    const grid = new SpatialGrid(params.sampleRadius);
    for (let i = 0; i < totalSplats; i++) {
        if (!selectedSet.has(i) && (state[i] & State.deleted) === 0) {
            grid.insert(i, getX[i], getY[i], getZ[i]);
        }
    }

    // ---- Step 2: Generate new splat positions based on strategy ----
    let newPositions: NewSplat[];

    if (params.strategy === HealStrategy.Original) {
        // Strategy A: use original positions of selected splats
        newPositions = selectedIndices.map(i => ({ x: getX[i], y: getY[i], z: getZ[i] }));
    } else if (params.strategy === HealStrategy.Poisson) {
        // Strategy B: poisson disk sampling within selected AABB
        newPositions = poissonSample(selectedIndices, getX, getY, getZ, params.poissonDensity);
    } else {
        // Strategy C: K-NN weighted average + jitter
        newPositions = knnGenerate(selectedIndices, getX, getY, getZ, grid, params);
    }

    const count = newPositions.length;
    if (count === 0) {
        return { elements: [], count: 0 };
    }

    // ---- Step 3: Interpolate properties for each new splat ----
    const rand = new SeededRandom(42);

    // Create output arrays
    const outX = new Float32Array(count);
    const outY = new Float32Array(count);
    const outZ = new Float32Array(count);
    const outScale0 = new Float32Array(count);
    const outScale1 = new Float32Array(count);
    const outScale2 = new Float32Array(count);
    const outRot0 = new Float32Array(count);
    const outRot1 = new Float32Array(count);
    const outRot2 = new Float32Array(count);
    const outRot3 = new Float32Array(count);
    const outFdc0 = new Float32Array(count);
    const outFdc1 = new Float32Array(count);
    const outFdc2 = new Float32Array(count);
    const outOpacity = new Float32Array(count);
    const outState = new Uint8Array(count); // state = 0 (no flags set)
    const outSh: Float32Array[] = [];
    for (let i = 0; i < totalShProps; i++) {
        outSh.push(new Float32Array(count));
    }

    for (let i = 0; i < count; i++) {
        const pos = newPositions[i];

        // Find neighbors within sample radius
        const neighborIndices = grid.findInRadius(pos.x, pos.y, pos.z, params.sampleRadius);

        if (neighborIndices.length === 0) {
            // No neighbors found - use nearest selected splat as fallback
            const srcIdx = selectedIndices[Math.min(i, selectedIndices.length - 1)];
            outX[i] = pos.x;
            outY[i] = pos.y;
            outZ[i] = pos.z;
            outScale0[i] = getScale0[srcIdx];
            outScale1[i] = getScale1[srcIdx];
            outScale2[i] = getScale2[srcIdx];
            outRot0[i] = getRot0[srcIdx];
            outRot1[i] = getRot1[srcIdx];
            outRot2[i] = getRot2[srcIdx];
            outRot3[i] = getRot3[srcIdx];
            outFdc0[i] = getFdc0[srcIdx];
            outFdc1[i] = getFdc1[srcIdx];
            outFdc2[i] = getFdc2[srcIdx];
            outOpacity[i] = getOpacity[srcIdx];
            for (let s = 0; s < totalShProps; s++) {
                outSh[s][i] = shArrays[s][srcIdx];
            }
            continue;
        }

        // Compute distance-weighted interpolation
        const k = Math.min(params.knnK, neighborIndices.length);
        const weighted: { idx: number, weight: number }[] = [];

        for (const idx of neighborIndices) {
            const dx = getX[idx] - pos.x;
            const dy = getY[idx] - pos.y;
            const dz = getZ[idx] - pos.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            const weight = 1 / (distSq + 1e-8);
            weighted.push({ idx, weight });
        }

        // Sort by weight (descending) and take top K
        weighted.sort((a, b) => b.weight - a.weight);
        const topK = weighted.slice(0, k);

        const totalWeight = topK.reduce((sum, w) => sum + w.weight, 0);

        // Interpolate position (keep generated position, don't override)
        outX[i] = pos.x;
        outY[i] = pos.y;
        outZ[i] = pos.z;

        // Add jitter to position
        if (params.jitter > 0) {
            const avgScale = Math.exp((getScale0[topK[0].idx] + getScale1[topK[0].idx] + getScale2[topK[0].idx]) / 3);
            const jitterAmount = avgScale * params.jitter;
            outX[i] += rand.range(-jitterAmount, jitterAmount);
            outY[i] += rand.range(-jitterAmount, jitterAmount);
            outZ[i] += rand.range(-jitterAmount, jitterAmount);
        }

        // Interpolate scale (in log space)
        let s0 = 0, s1 = 0, s2 = 0;
        for (const w of topK) {
            const nw = w.weight / totalWeight;
            s0 += getScale0[w.idx] * nw;
            s1 += getScale1[w.idx] * nw;
            s2 += getScale2[w.idx] * nw;
        }
        // Add small jitter to scale
        if (params.jitter > 0) {
            const scaleJitter = params.jitter * 0.3;
            s0 += rand.range(-scaleJitter, scaleJitter);
            s1 += rand.range(-scaleJitter, scaleJitter);
            s2 += rand.range(-scaleJitter, scaleJitter);
        }
        outScale0[i] = s0;
        outScale1[i] = s1;
        outScale2[i] = s2;

        // Interpolate rotation (weighted average + normalize)
        let r0 = 0, r1 = 0, r2 = 0, r3 = 0;
        for (const w of topK) {
            const nw = w.weight / totalWeight;
            r0 += getRot0[w.idx] * nw;
            r1 += getRot1[w.idx] * nw;
            r2 += getRot2[w.idx] * nw;
            r3 += getRot3[w.idx] * nw;
        }
        const q = quatNormalize({ w: r0, x: r1, y: r2, z: r3 });
        outRot0[i] = q.w;
        outRot1[i] = q.x;
        outRot2[i] = q.y;
        outRot3[i] = q.z;

        // Interpolate color (linear)
        let dc0 = 0, dc1 = 0, dc2 = 0;
        for (const w of topK) {
            const nw = w.weight / totalWeight;
            dc0 += getFdc0[w.idx] * nw;
            dc1 += getFdc1[w.idx] * nw;
            dc2 += getFdc2[w.idx] * nw;
        }
        outFdc0[i] = dc0;
        outFdc1[i] = dc1;
        outFdc2[i] = dc2;

        // Interpolate opacity (in sigmoid space)
        let op = 0;
        for (const w of topK) {
            const nw = w.weight / totalWeight;
            op += decodeOpacity(getOpacity[w.idx]) * nw;
        }
        outOpacity[i] = encodeOpacity(op);

        // Interpolate SH coefficients (linear)
        for (let s = 0; s < totalShProps; s++) {
            let val = 0;
            for (const w of topK) {
                const nw = w.weight / totalWeight;
                val += shArrays[s][w.idx] * nw;
            }
            outSh[s][i] = val;
        }
    }

    // ---- Step 4: Build GSplatData elements ----
    const properties: any[] = [
        { type: 'float', name: 'x', storage: outX, byteSize: 4 },
        { type: 'float', name: 'y', storage: outY, byteSize: 4 },
        { type: 'float', name: 'z', storage: outZ, byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: outScale0, byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: outScale1, byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: outScale2, byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: outRot0, byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: outRot1, byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: outRot2, byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: outRot3, byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: outFdc0, byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: outFdc1, byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: outFdc2, byteSize: 4 },
        { type: 'float', name: 'opacity', storage: outOpacity, byteSize: 4 },
        { type: 'uint8', name: 'state', storage: outState, byteSize: 1 }
    ];

    for (let s = 0; s < totalShProps; s++) {
        properties.push({
            type: 'float',
            name: `f_rest_${s}`,
            storage: outSh[s],
            byteSize: 4
        });
    }

    const elements = [{
        name: 'vertex',
        count,
        properties
    }];

    return { elements, count };
}

// ================================================================
//  Poisson disk sampling (3D Bridson's algorithm, simplified)
// ================================================================

function poissonSample(
    selectedIndices: number[],
    getX: Float32Array, getY: Float32Array, getZ: Float32Array,
    radius: number
): NewSplat[] {
    // Compute AABB of selected region
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const idx of selectedIndices) {
        minX = Math.min(minX, getX[idx]); maxX = Math.max(maxX, getX[idx]);
        minY = Math.min(minY, getY[idx]); maxY = Math.max(maxY, getY[idx]);
        minZ = Math.min(minZ, getZ[idx]); maxZ = Math.max(maxZ, getZ[idx]);
    }

    // Expand AABB slightly
    const expand = radius * 0.5;
    minX -= expand; minY -= expand; minZ -= expand;
    maxX += expand; maxY += expand; maxZ += expand;

    const rand = new SeededRandom(42);
    const result: NewSplat[] = [];
    const cellSize = radius / Math.sqrt(3);
    const gridW = Math.ceil((maxX - minX) / cellSize);
    const gridH = Math.ceil((maxY - minY) / cellSize);
    const gridD = Math.ceil((maxZ - minZ) / cellSize);
    const gridArr: Int32Array = new Int32Array(gridW * gridH * gridD).fill(-1);

    const gridIdx = (x: number, y: number, z: number) => {
        const gx = Math.floor((x - minX) / cellSize);
        const gy = Math.floor((y - minY) / cellSize);
        const gz = Math.floor((z - minZ) / cellSize);
        return gz * gridW * gridH + gy * gridW + gx;
    };

    const isFarEnough = (x: number, y: number, z: number): boolean => {
        const gx = Math.floor((x - minX) / cellSize);
        const gy = Math.floor((y - minY) / cellSize);
        const gz = Math.floor((z - minZ) / cellSize);
        const r = 2;
        for (let dz = -r; dz <= r; dz++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    const nx = gx + dx, ny = gy + dy, nz = gz + dz;
                    if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH || nz < 0 || nz >= gridD) continue;
                    const idx = gridArr[nz * gridW * gridH + ny * gridW + nx];
                    if (idx >= 0) {
                        const px = result[idx].x;
                        const py = result[idx].y;
                        const pz = result[idx].z;
                        const ddx = px - x, ddy = py - y, ddz = pz - z;
                        if (ddx * ddx + ddy * ddy + ddz * ddz < radius * radius) {
                            return false;
                        }
                    }
                }
            }
        }
        return true;
    };

    // Bridson's algorithm
    const active: number[] = [];

    // Seed point: center of AABB
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    result.push({ x: cx, y: cy, z: cz });
    gridArr[gridIdx(cx, cy, cz)] = 0;
    active.push(0);

    const maxPoints = selectedIndices.length * 2;
    const maxAttempts = 30;

    while (active.length > 0 && result.length < maxPoints) {
        const idx = active[Math.floor(rand.next() * active.length)];
        const px = result[idx].x;
        const py = result[idx].y;
        const pz = result[idx].z;

        let found = false;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const angle1 = rand.next() * Math.PI * 2;
            const angle2 = rand.next() * Math.PI;
            const r = radius * (1 + rand.next());
            const newx = px + r * Math.sin(angle2) * Math.cos(angle1);
            const newy = py + r * Math.sin(angle2) * Math.sin(angle1);
            const newz = pz + r * Math.cos(angle2);

            if (newx < minX || newx > maxX || newy < minY || newy > maxY || newz < minZ || newz > maxZ) continue;

            if (isFarEnough(newx, newy, newz)) {
                const newIdx = result.length;
                result.push({ x: newx, y: newy, z: newz });
                gridArr[gridIdx(newx, newy, newz)] = newIdx;
                active.push(newIdx);
                found = true;
                break;
            }
        }

        if (!found) {
            const removeIdx = active.indexOf(idx);
            if (removeIdx >= 0) active.splice(removeIdx, 1);
        }
    }

    return result;
}

// ================================================================
//  K-NN weighted position generation
// ================================================================

function knnGenerate(
    selectedIndices: number[],
    getX: Float32Array, getY: Float32Array, getZ: Float32Array,
    grid: SpatialGrid,
    params: HealParams
): NewSplat[] {
    const rand = new SeededRandom(42);
    const result: NewSplat[] = [];

    for (const srcIdx of selectedIndices) {
        const px = getX[srcIdx];
        const py = getY[srcIdx];
        const pz = getZ[srcIdx];

        // Find neighbors
        const neighborIndices = grid.findInRadius(px, py, pz, params.sampleRadius);
        if (neighborIndices.length === 0) {
            result.push({ x: px, y: py, z: pz });
            continue;
        }

        // Compute weighted average position
        let wx = 0, wy = 0, wz = 0;
        let totalWeight = 0;

        for (const idx of neighborIndices) {
            const dx = getX[idx] - px;
            const dy = getY[idx] - py;
            const dz = getZ[idx] - pz;
            const distSq = dx * dx + dy * dy + dz * dz;
            const weight = 1 / (distSq + 1e-8);
            wx += getX[idx] * weight;
            wy += getY[idx] * weight;
            wz += getZ[idx] * weight;
            totalWeight += weight;
        }

        wx /= totalWeight;
        wy /= totalWeight;
        wz /= totalWeight;

        // Use neighbor average position entirely (blend = 1.0)
        // The original position is in the "hole" being healed, so we want
        // new points to be placed among surrounding neighbors instead.
        const blend = 1.0;
        let newX = px * (1 - blend) + wx * blend;
        let newY = py * (1 - blend) + wy * blend;
        let newZ = pz * (1 - blend) + wz * blend;

        // Add jitter
        if (params.jitter > 0) {
            // Estimate average scale from neighbors
            const jitterAmount = params.sampleRadius * params.jitter * 0.3;
            newX += rand.range(-jitterAmount, jitterAmount);
            newY += rand.range(-jitterAmount, jitterAmount);
            newZ += rand.range(-jitterAmount, jitterAmount);
        }

        result.push({ x: newX, y: newY, z: newZ });
    }

    return result;
}

// ================================================================
//  Get selected splat indices from state array
// ================================================================

function getSelectedIndices(splat: Splat): number[] {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const indices: number[] = [];
    for (let i = 0; i < state.length; i++) {
        if (state[i] === State.selected) {
            indices.push(i);
        }
    }
    return indices;
}

export {
    HealStrategy,
    HealParams,
    HealResult,
    healInpaint,
    getSelectedIndices
};
