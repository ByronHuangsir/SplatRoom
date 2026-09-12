import { BoundingBox } from 'playcanvas';

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

// The bound the volume selection should act on: the selected splats when there are any,
// otherwise every visible splat. Null when the scene has no splats.
//
// The bound is derived from each splat's LOCAL bound through its current world transform
// rather than read from `splat.worldBound`: that cached copy is only refreshed on the
// app's own transform paths, so a model moved by any other route would leave the volume
// fitted to where the model used to be.
const selectionTargetBound = (events: Events, scene: Scene): BoundingBox | null => {
    const selected = (events.invoke('selection.all') as Splat[]) ?? [];
    const splats = (selected.length ? selected : scene.getElementsByType(ElementType.splat)) as Splat[];
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

// fit an axis-aligned box (side lengths live on the shape) over the bound
const fitBoxToBound = (box: { pivot: any, lenX: number, lenY: number, lenZ: number, moved: () => void }, bound: BoundingBox) => {
    const { center, halfExtents } = bound;
    const min = 0.01;
    box.pivot.setPosition(center);
    box.pivot.setLocalEulerAngles(0, 0, 0);
    box.lenX = Math.max(min, halfExtents.x * 2);
    box.lenY = Math.max(min, halfExtents.y * 2);
    box.lenZ = Math.max(min, halfExtents.z * 2);
    box.moved();
};

// fit a sphere (radius lives on the shape, the pivot scale carries the diameter) over
// the bound: the half diagonal radius guarantees it contains the whole bound
const fitSphereToBound = (sphere: { pivot: any, radius: number, moved: () => void }, bound: BoundingBox) => {
    const { center, halfExtents } = bound;
    sphere.pivot.setPosition(center);
    sphere.radius = Math.max(0.01, halfExtents.length());
    sphere.moved();
};

export { selectionTargetBound, volumeReachesTarget, fitBoxToBound, fitSphereToBound };
