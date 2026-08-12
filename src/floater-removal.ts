import { Splat } from './splat';
import { State } from './splat-state';

export interface FloaterParams {
    opacityThreshold: number;       // Strategy 2: splats with opacity below this are floaters (0-1)
    volumeStdThreshold: number;     // Strategy 3: splats with volume > mean + k*std are floaters
    neighborRadius: number;         // Strategy 1: search radius for neighbor counting (scene units)
    minNeighbors: number;           // Strategy 1: minimum neighbors within radius
    distanceThreshold: number;      // Strategy 4: normalized 0-1, fraction of scene diagonal
}

export interface FloaterStrategies {
    opacity: boolean;
    volume: boolean;
    isolation: boolean;
    distance: boolean;
}

export interface FloaterResult {
    mask: Uint8Array;               // 255 = floater, 0 = normal
    count: number;
    details: {
        opacity: number;
        volume: number;
        isolation: number;
        distance: number;
    };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Detect floating gaussian splats based on multiple strategies.
 * Only considers non-deleted, non-locked splats.
 */
export function detectFloaters(splat: Splat, strategies: FloaterStrategies, params: FloaterParams): FloaterResult {
    const splatData = splat.splatData;
    const numSplats = splatData.numSplats;
    const state = splatData.getProp('state') as Uint8Array;
    const mask = new Uint8Array(numSplats);
    const details = { opacity: 0, volume: 0, isolation: 0, distance: 0 };

    // Get raw properties (may be null for some file formats)
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const opacity = splatData.getProp('opacity') as Float32Array;
    const scale0 = splatData.getProp('scale_0') as Float32Array;
    const scale1 = splatData.getProp('scale_1') as Float32Array;
    const scale2 = splatData.getProp('scale_2') as Float32Array;

    // Only consider non-deleted, non-locked splats
    const isValid = (i: number) => (state[i] & (State.deleted | State.locked)) === 0;

    // ---- Strategy 2: Low opacity ----
    if (strategies.opacity && opacity) {
        for (let i = 0; i < numSplats; i++) {
            if (isValid(i) && sigmoid(opacity[i]) < params.opacityThreshold) {
                mask[i] = 255;
                details.opacity++;
            }
        }
    }

    // ---- Strategy 3: Abnormal volume ----
    if (strategies.volume && scale0 && scale1 && scale2) {
        let sum = 0, sumSq = 0, count = 0;
        const volumes = new Float32Array(numSplats);
        for (let i = 0; i < numSplats; i++) {
            if (isValid(i)) {
                // Volume = product of semi-axes (stored as log scale)
                const vol = Math.exp(scale0[i]) * Math.exp(scale1[i]) * Math.exp(scale2[i]);
                volumes[i] = vol;
                sum += vol;
                sumSq += vol * vol;
                count++;
            }
        }
        if (count > 0) {
            const mean = sum / count;
            const variance = Math.max(0, sumSq / count - mean * mean);
            const std = Math.sqrt(variance);
            const threshold = mean + params.volumeStdThreshold * std;
            for (let i = 0; i < numSplats; i++) {
                if (isValid(i) && volumes[i] > threshold) {
                    mask[i] = 255;
                    details.volume++;
                }
            }
        }
    }

    // ---- Strategy 4: Far from main body ----
    if (strategies.distance && x && y && z) {
        // Compute centroid and scene diagonal
        let cx = 0, cy = 0, cz = 0, count = 0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < numSplats; i++) {
            if (isValid(i)) {
                cx += x[i]; cy += y[i]; cz += z[i];
                if (x[i] < minX) minX = x[i];
                if (y[i] < minY) minY = y[i];
                if (z[i] < minZ) minZ = z[i];
                if (x[i] > maxX) maxX = x[i];
                if (y[i] > maxY) maxY = y[i];
                if (z[i] > maxZ) maxZ = z[i];
                count++;
            }
        }
        if (count > 0) {
            cx /= count; cy /= count; cz /= count;
            const diag = Math.sqrt(
                (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2
            );
            // Normalized threshold: fraction of scene diagonal
            const distThreshold = params.distanceThreshold * diag;
            const distSq = distThreshold * distThreshold;
            for (let i = 0; i < numSplats; i++) {
                if (isValid(i)) {
                    const dx = x[i] - cx;
                    const dy = y[i] - cy;
                    const dz = z[i] - cz;
                    if (dx * dx + dy * dy + dz * dz > distSq) {
                        mask[i] = 255;
                        details.distance++;
                    }
                }
            }
        }
    }

    // ---- Strategy 1: Spatial isolation (grid-based) ----
    if (strategies.isolation && x && y && z) {
        const cellSize = params.neighborRadius;
        if (cellSize > 0) {
            // Build uniform grid: cell key → splat count
            const grid = new Map<string, number>();
            for (let i = 0; i < numSplats; i++) {
                if (isValid(i)) {
                    const gcx = Math.floor(x[i] / cellSize);
                    const gcy = Math.floor(y[i] / cellSize);
                    const gcz = Math.floor(z[i] / cellSize);
                    const key = gcx + ',' + gcy + ',' + gcz;
                    grid.set(key, (grid.get(key) || 0) + 1);
                }
            }

            // Check each splat: count neighbors in 3x3x3 surrounding cells
            for (let i = 0; i < numSplats; i++) {
                if (isValid(i)) {
                    const gcx = Math.floor(x[i] / cellSize);
                    const gcy = Math.floor(y[i] / cellSize);
                    const gcz = Math.floor(z[i] / cellSize);

                    let neighborCount = 0;
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dz = -1; dz <= 1; dz++) {
                                const key = (gcx + dx) + ',' + (gcy + dy) + ',' + (gcz + dz);
                                neighborCount += grid.get(key) || 0;
                            }
                        }
                    }
                    // Subtract self (counted in center cell)
                    neighborCount--;

                    if (neighborCount < params.minNeighbors) {
                        if (mask[i] !== 255) {
                            mask[i] = 255;
                            details.isolation++;
                        }
                    }
                }
            }
        }
    }

    // Count total unique floaters
    let count = 0;
    for (let i = 0; i < numSplats; i++) {
        if (mask[i] === 255) count++;
    }

    return { mask, count, details };
}

/**
 * Quick preset: Strategy 2 (opacity) + Strategy 3 (volume)
 */
export const QUICK_STRATEGIES: FloaterStrategies = {
    opacity: true,
    volume: true,
    isolation: false,
    distance: false
};

/**
 * Fine preset: All four strategies
 */
export const FINE_STRATEGIES: FloaterStrategies = {
    opacity: true,
    volume: true,
    isolation: true,
    distance: true
};

/**
 * Default parameters for quick mode
 */
export const QUICK_DEFAULTS: FloaterParams = {
    opacityThreshold: 0.02,
    volumeStdThreshold: 5,
    neighborRadius: 0.05,
    minNeighbors: 5,
    distanceThreshold: 0.5
};

/**
 * Default parameters for fine mode
 */
export const FINE_DEFAULTS: FloaterParams = {
    opacityThreshold: 0.02,
    volumeStdThreshold: 5,
    neighborRadius: 0.05,
    minNeighbors: 5,
    distanceThreshold: 0.5
};
