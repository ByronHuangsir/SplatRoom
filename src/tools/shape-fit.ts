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

// Default volume sizes. The volumes are tools the user places and resizes, so they start
// small enough to be seen and grabbed: a volume fitted to the WHOLE model hugs its surface,
// where the grid strips disappear into the geometry (and the scale gizmo's handles end up
// buried inside the model, which is what made the tool feel unusable).
const BOX_FIT = 0.5;      // half the model extent on each axis
const SPHERE_FIT = 0.5;   // half the target's half-diagonal radius

// Where to put a freshly fitted volume: on the side of the model facing the camera,
// straddling its near face. Centring on the bound looks natural but lands in empty space
// for a shell-like model (a room scan is hollow, so a volume in its middle selects
// nothing), while a volume that spans the whole model cannot be seen or grabbed. Straddling
// the near face puts it on the geometry the user is looking at, and keeps it small.
const placementCentre = (bound: BoundingBox, scene: Scene, out: Vec3) => {
    const { center, halfExtents } = bound;
    out.copy(center);
    const camera = scene.camera?.mainCamera;
    if (!camera) {
        return out;
    }
    const forward = camera.forward;
    // bound extent along the view axis: how far the near face is from the centre
    const extentAlong = Math.abs(forward.x) * halfExtents.x +
        Math.abs(forward.y) * halfExtents.y +
        Math.abs(forward.z) * halfExtents.z;
    out.x -= forward.x * extentAlong * 0.5;
    out.y -= forward.y * extentAlong * 0.5;
    out.z -= forward.z * extentAlong * 0.5;
    return out;
};

const placement = new Vec3();

// fit an axis-aligned box (side lengths live on the shape) over the bound
const fitBoxToBound = (scene: Scene, box: { pivot: any, lenX: number, lenY: number, lenZ: number, moved: () => void }, bound: BoundingBox) => {
    const { halfExtents } = bound;
    const min = 0.01;
    box.pivot.setPosition(placementCentre(bound, scene, placement));
    box.pivot.setLocalEulerAngles(0, 0, 0);
    box.lenX = Math.max(min, halfExtents.x * 2 * BOX_FIT);
    box.lenY = Math.max(min, halfExtents.y * 2 * BOX_FIT);
    box.lenZ = Math.max(min, halfExtents.z * 2 * BOX_FIT);
    box.moved();
};

// fit a sphere (radius lives on the shape, the pivot scale carries the diameter) over
// the bound
const fitSphereToBound = (scene: Scene, sphere: { pivot: any, radius: number, moved: () => void }, bound: BoundingBox) => {
    const { halfExtents } = bound;
    sphere.pivot.setPosition(placementCentre(bound, scene, placement));
    sphere.radius = Math.max(0.01, halfExtents.length() * SPHERE_FIT);
    sphere.moved();
};

export { selectionTargetBound, volumeReachesTarget, fitBoxToBound, fitSphereToBound };
