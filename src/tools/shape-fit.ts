import { BoundingBox, Vec3 } from 'playcanvas';

import { Events } from '../core/events';
import { ElementType } from '../scene/element';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';

// The box/sphere selection volumes are transient tool state that the user positions
// through the gizmo or the toolbar inputs. They used to keep whatever placement they had
// from a previous session (initially the world origin with a 2x2x2 box / radius-1 sphere),
// so with a model that is not centred on the origin, activating the tool left the volume
// nowhere near the splats and pressing "set" selected nothing at all — the tool looked
// broken. These helpers give the tools a target to fit to, and let them tell when a
// volume has drifted away from it.

// The splats a volume selection should act on: the selected splats when there are any,
// otherwise every splat. Null when the scene has no splats.
const selectionTargetSplats = (events: Events, scene: Scene): Splat[] => {
    const selected = (events.invoke('selection.all') as Splat[]) ?? [];
    if (selected.length) {
        return selected;
    }
    return scene.getElementsByType(ElementType.splat) as Splat[];
};

// The bound of those splats, derived from each splat's LOCAL bound through its current world
// transform rather than read from `splat.worldBound`: that cached copy is only refreshed on
// the app's own transform paths, so a model moved by any other route would leave the volume
// fitted to where the model used to be.
const selectionTargetBound = (events: Events, scene: Scene): BoundingBox | null => {
    const splats = selectionTargetSplats(events, scene);
    if (!splats.length) {
        return null;
    }

    const bound = new BoundingBox();
    let any = false;
    for (const splat of splats) {
        const local = splat?.localBound;
        if (!local) {
            continue;
        }
        const world = new BoundingBox();
        world.setFromTransformedAabb(local, splat.entity.getWorldTransform());
        if (any) {
            bound.add(world);
        } else {
            bound.copy(world);
            any = true;
        }
    }

    return any ? bound : null;
};

// whether a volume is worth keeping: a volume that does not touch the current target
// cannot select anything, so it is re-fitted instead
const volumeReachesTarget = (volumeBound: BoundingBox, target: BoundingBox) => {
    return volumeBound.intersects(target);
};

// Default volume size: a fraction of the model. A volume fitted to the WHOLE model hugs its
// surface, where the grid strips disappear into the geometry and the scale gizmo's handles
// end up buried inside the model, which is what made the tool feel unusable; a third of the
// model is small enough to see and grab, and still big enough to cover the dense middle of
// the scene where the user usually wants to start.
const VOLUME_FRACTION = 0.3;

// Where a freshly fitted volume goes: on the centre of the gaussian density, i.e. the
// per-axis MEDIAN of the splat centres of the target, in world space. Not the centre of the
// bounding box: geometry is rarely spread evenly through its box (a room scan is a hollow
// shell, a captured object often sits on one side of the stray gaussians around it), so the
// box centre frequently lands in empty space while the mass of gaussians is somewhere else.
// The median is used rather than the mean because a handful of far-away floaters can drag a
// mean a long way.
//
// Sampling is strided so the cost stays flat for large models (a 5M splat model is sampled
// down to ~64k centres), and the result is memoised: activating a tool asks for the same
// centre over and over, and `getCenters()` copies the whole position array.
const SAMPLE_LIMIT = 65536;

let densityKey = '';
const densityCentreStorage = new Vec3();

const splatsKey = (splats: Splat[]) => {
    let key = '';
    for (const splat of splats) {
        // identity + count + world transform: any of those changing invalidates the centre
        key += `${splat.entity.getGuid()}:${splat.numSplats}:${splat.entity.getWorldTransform().data.join(',')};`;
    }
    return key;
};

const densityCentre = (splats: Splat[], fallback: BoundingBox, out: Vec3): Vec3 => {
    const key = splatsKey(splats);
    if (key === densityKey) {
        return out.copy(densityCentreStorage);
    }

    let total = 0;
    for (const splat of splats) {
        total += splat.numSplats ?? 0;
    }
    const stride = Math.max(1, Math.ceil(total / SAMPLE_LIMIT));

    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const point = new Vec3();
    for (const splat of splats) {
        const data: any = splat?.splatData;
        if (!data || typeof data.getCenters !== 'function') {
            continue;
        }
        let centers: Float32Array;
        try {
            centers = data.getCenters() as Float32Array;
        } catch (e) {
            continue;
        }
        if (!centers) {
            continue;
        }
        const count = centers.length / 3;
        const transform = splat.entity.getWorldTransform();
        for (let i = 0; i < count; i += stride) {
            point.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
            transform.transformPoint(point, point);
            xs.push(point.x);
            ys.push(point.y);
            zs.push(point.z);
        }
    }

    if (!xs.length) {
        // no readable positions (unusual format): the bound centre is the best we have
        out.copy(fallback.center);
        return out;
    }

    const mid = (values: number[]) => {
        values.sort((a, b) => a - b);
        return values[values.length >> 1];
    };
    out.set(mid(xs), mid(ys), mid(zs));

    densityKey = key;
    densityCentreStorage.copy(out);
    return out;
};

const placement = new Vec3();

// fit an axis-aligned box (side lengths live on the shape) over the target
const fitBoxToBound = (scene: Scene, box: { pivot: any, lenX: number, lenY: number, lenZ: number, moved: () => void }, bound: BoundingBox, splats: Splat[]) => {
    const { halfExtents } = bound;
    const min = 0.01;
    box.pivot.setPosition(densityCentre(splats, bound, placement));
    box.pivot.setLocalEulerAngles(0, 0, 0);
    box.lenX = Math.max(min, halfExtents.x * 2 * VOLUME_FRACTION);
    box.lenY = Math.max(min, halfExtents.y * 2 * VOLUME_FRACTION);
    box.lenZ = Math.max(min, halfExtents.z * 2 * VOLUME_FRACTION);
    box.moved();
};

// fit a sphere (radius lives on the shape, the pivot scale carries the diameter) over the
// target: the diameter is the same fraction of the model the box uses, measured on the
// model's largest dimension so the two tools start at a comparable size
const fitSphereToBound = (scene: Scene, sphere: { pivot: any, radius: number, moved: () => void }, bound: BoundingBox, splats: Splat[]) => {
    const { halfExtents } = bound;
    const maxExtent = Math.max(halfExtents.x, halfExtents.y, halfExtents.z) * 2;
    sphere.pivot.setPosition(densityCentre(splats, bound, placement));
    sphere.radius = Math.max(0.01, maxExtent * VOLUME_FRACTION * 0.5);
    sphere.moved();
};

export { selectionTargetSplats, selectionTargetBound, volumeReachesTarget, fitBoxToBound, fitSphereToBound };
