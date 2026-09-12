import { ElementType } from '../scene/element';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';

// A selection volume is much easier to place when the model behind it is faded out - that is
// what the camera-path control already does (scene.ts: `transparency = exp(-2)` while path
// control is on, back to `exp(0) = 1` when it goes off), and the same -2 is what the colour
// panel's transparency slider shows for it (`panel.colors.transparency`, value = ln(strength)).
//
// The box and sphere tools dim the model the same way while they are active, keeping each
// splat's own value so leaving the tool restores exactly what the user had, and restoring only
// splats that are still at the dimmed value (so a transparency the user changed in the
// meantime is left alone). A counter keeps the two tools, which can overlap while switching
// between them, from restoring each other's dimming.
const DIM_TRANSPARENCY = Math.exp(-2);

const saved = new Map<Splat, number>();
let activeTools = 0;

const dimModelForVolumeTool = (scene: Scene) => {
    activeTools++;
    if (activeTools > 1) {
        return;
    }
    saved.clear();
    for (const splat of scene.getElementsByType(ElementType.splat) as Splat[]) {
        saved.set(splat, splat.transparency);
        splat.transparency = DIM_TRANSPARENCY;
    }
};

const restoreModelAfterVolumeTool = (scene: Scene) => {
    activeTools = Math.max(0, activeTools - 1);
    if (activeTools > 0) {
        return;
    }
    for (const [splat, transparency] of saved) {
        if (splat.transparency === DIM_TRANSPARENCY) {
            splat.transparency = transparency;
        }
    }
    saved.clear();
};

export { dimModelForVolumeTool, restoreModelAfterVolumeTool, DIM_TRANSPARENCY };
