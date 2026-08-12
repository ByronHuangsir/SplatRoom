import { Color, Vec3 } from 'playcanvas';
import { Events } from '../events';
import { Splat } from '../splat';
import { AnimationTrackBase } from './animation-track-base';

/**
 * Color animation track.
 * Captures all 10 color adjustment properties from the selected splat.
 * Value order: tintClr.r, tintClr.g, tintClr.b, temperature, saturation,
 *              brightness, contrast, highlights, shadows, whitePoint,
 *              blackPoint, transparency
 * NOTE: This is 12 dimensions (3 for tint color + 9 for other properties)
 */
class ColorAnimTrack extends AnimationTrackBase {
    // Override dim - color track has 12 dimensions
    readonly dim = 12;

    constructor(events: Events) {
        super(events, 'color', 'Color');
    }

    captureValue(): number[] {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat) return [];
        return [
            splat.tintClr.r, splat.tintClr.g, splat.tintClr.b,
            splat.temperature,
            splat.saturation,
            splat.brightness,
            splat.contrast,
            splat.highlights,
            splat.shadows,
            splat.whitePoint,
            splat.blackPoint,
            splat.transparency
        ];
    }

    applyValue(value: number[]): void {
        const splat = this.events.invoke('selection') as Splat;
        if (!splat) return;
        splat.tintClr = new Color(value[0], value[1], value[2]);
        splat.temperature = value[3];
        splat.saturation = value[4];
        splat.brightness = value[5];
        splat.contrast = value[6];
        splat.highlights = value[7];
        splat.shadows = value[8];
        splat.whitePoint = value[9];
        splat.blackPoint = value[10];
        splat.transparency = value[11];
    }
}

export { ColorAnimTrack };
