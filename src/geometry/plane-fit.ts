import { Vec3 } from 'playcanvas';

import { eigenDecompSym3x3 } from './surface-analyzer';

/**
 * Plane representation in **splat-local** space.
 *
 * All positions fed to / returned from this module live in the splat's own
 * local coordinate frame (the same frame the GSplatData x/y/z columns are
 * stored in). This keeps the math consistent with how the data is stored and
 * avoids the world/local mismatch that caused earlier bugs.
 */
export interface Plane {
    /** A point on the plane (world or local — caller's responsibility). */
    origin: Vec3;
    /** Unit plane normal. */
    normal: Vec3;
    /** Unit in-plane basis vector (u × v = normal). */
    u: Vec3;
    /** Unit in-plane basis vector. */
    v: Vec3;
}

function basisFromNormal(n: Vec3): { u: Vec3; v: Vec3 } {
    // pick a reference axis that is not parallel to n
    const ref = Math.abs(n.y) < 0.99 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    const u = new Vec3().cross(ref, n).normalize();
    const v = new Vec3().cross(n, u).normalize();
    return { u, v };
}

/**
 * Fit a plane through the given points.
 * - exactly 3 points → cross product of edge vectors (exact).
 * - 4+ points → PCA; the plane normal is the eigenvector of the smallest
 *   covariance eigenvalue.
 */
export function fitPlane(points: Vec3[]): Plane {
    const n = points.length;
    if (n < 3) {
        throw new Error('fitPlane requires at least 3 points');
    }

    if (n === 3) {
        const ab = new Vec3().sub2(points[1], points[0]);
        const ac = new Vec3().sub2(points[2], points[0]);
        const normal = new Vec3().cross(ab, ac);
        if (normal.lengthSq() < 1e-12) {
            // degenerate (collinear) — fall through to PCA
            return fitPlanePCA(points);
        }
        normal.normalize();
        const { u, v } = basisFromNormal(normal);
        return { origin: points[0].clone(), normal, u, v };
    }

    return fitPlanePCA(points);
}

function fitPlanePCA(points: Vec3[]): Plane {
    const n = points.length;
    const centroid = new Vec3();
    for (const p of points) centroid.add(p);
    centroid.mulScalar(1 / n);

    // symmetric covariance 3×3
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    for (const p of points) {
        const dx = p.x - centroid.x;
        const dy = p.y - centroid.y;
        const dz = p.z - centroid.z;
        c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
        c11 += dy * dy; c12 += dy * dz;
        c22 += dz * dz;
    }
    const inv = 1 / n;
    const C: [number, number, number][] = [
        [c00 * inv, c01 * inv, c02 * inv],
        [c01 * inv, c11 * inv, c12 * inv],
        [c02 * inv, c12 * inv, c22 * inv]
    ];

    const { values, vectors } = eigenDecompSym3x3(C);
    const normal = new Vec3(vectors[2][0], vectors[2][1], vectors[2][2]);
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
    normal.normalize();
    const { u, v } = basisFromNormal(normal);
    return { origin: centroid, normal, u, v };
}

/** Signed distance from a point to the plane (negative = behind normal). */
export function pointToPlaneDistance(p: Vec3, plane: Plane): number {
    const dx = p.x - plane.origin.x;
    const dy = p.y - plane.origin.y;
    const dz = p.z - plane.origin.z;
    return dx * plane.normal.x + dy * plane.normal.y + dz * plane.normal.z;
}

/** Project a point onto the plane (d = 0). */
export function projectToPlane(p: Vec3, plane: Plane): Vec3 {
    const d = pointToPlaneDistance(p, plane);
    return new Vec3(
        p.x - d * plane.normal.x,
        p.y - d * plane.normal.y,
        p.z - d * plane.normal.z
    );
}

/** Decompose a point into in-plane (pu, pv) and normal (d) coordinates. */
export function projectToBasis(p: Vec3, plane: Plane): { pu: number; pv: number; d: number } {
    const dx = p.x - plane.origin.x;
    const dy = p.y - plane.origin.y;
    const dz = p.z - plane.origin.z;
    return {
        d: dx * plane.normal.x + dy * plane.normal.y + dz * plane.normal.z,
        pu: dx * plane.u.x + dy * plane.u.y + dz * plane.u.z,
        pv: dx * plane.v.x + dy * plane.v.y + dz * plane.v.z
    };
}

/** Reconstruct a local point from in-plane (pu, pv) and normal (d) coordinates. */
export function basisToLocal(pu: number, pv: number, d: number, plane: Plane): Vec3 {
    return new Vec3(
        plane.origin.x + pu * plane.u.x + pv * plane.v.x + d * plane.normal.x,
        plane.origin.y + pu * plane.u.y + pv * plane.v.y + d * plane.normal.y,
        plane.origin.z + pu * plane.u.z + pv * plane.v.z + d * plane.normal.z
    );
}

/** Ray-casting point-in-polygon test in 2D (polygon as array of [x,y]). */
export function pointInPolygon2D(x: number, y: number, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Andrew's monotone-chain convex hull of 2D points. */
export function convexHull2D(pts: [number, number][]): [number, number][] {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

    const lower: [number, number][] = [];
    for (const pt of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
        lower.push(pt);
    }
    const upper: [number, number][] = [];
    for (let i = p.length - 1; i >= 0; i--) {
        const pt = p[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
        upper.push(pt);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/** Expand a 2D polygon outward from its centroid by a fixed margin. */
export function dilatePolygon2D(poly: [number, number][], margin: number): [number, number][] {
    if (poly.length === 0 || margin <= 0) return poly;
    let cx = 0, cy = 0;
    for (const [x, y] of poly) {
        cx += x; cy += y;
    }
    cx /= poly.length; cy /= poly.length;
    return poly.map(([x, y]) => {
        const dx = x - cx, dy = y - cy;
        const len = Math.hypot(dx, dy) || 1;
        return [x + (dx / len) * margin, y + (dy / len) * margin] as [number, number];
    });
}

/** Axis-aligned bounding box of a 2D polygon. */
export function polygonBounds(poly: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
}
