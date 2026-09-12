import { ReadFileSystem } from '@playcanvas/splat-transform';
import { AppBase, Asset, GSplatData, GSplatResource } from 'playcanvas';

import { Events } from './events';
import { defaultLodIndex, loadGSplatDataAsync, validateGSplatData } from './io';
import { Splat } from './splat/splat';
import { detectGiantGreySplats, removeGiantGreySplats, shrinkGiantGreySplats } from './splat/splat-sanitize';
import { i18n } from './ui/localization';

// handles loading gsplat assets using splat-transform
class AssetLoader {
    app: AppBase;
    events: Events;

    constructor(app: AppBase, events: Events) {
        this.app = app;
        this.events = events;
    }

    // wrap in-memory GSplatData in a gsplat Asset + GSplatResource registered with
    // the engine. shared by the splat-transform load path and the PLY sequence
    // frame source, which already holds decoded GSplatData.
    createGSplatAsset(gsplatData: GSplatData, filename: string): Asset {
        const asset = new Asset(filename, 'gsplat', { url: `local-asset-${Date.now()}`, filename });
        this.app.assets.add(asset);
        asset.resource = new GSplatResource(this.app.graphicsDevice, gsplatData);
        return asset;
    }

    /**
     * Load a splat asset. `sanitize` controls the "giant grey splat" popup:
     * it must only fire for user-initiated imports — internal round-trips
     * (duplicate / separate / paste / document load / animation frames) would
     * otherwise pop the dialog repeatedly and interrupt editing.
     */
    async load(filename: string, fileSystem: ReadFileSystem, animationFrame?: boolean, skipReorder?: boolean, sanitize = false) {
        if (!animationFrame) {
            this.events.fire('startSpinner');
        }

        try {
            // ask the user which LOD to load when the file contains multiple,
            // pausing the spinner while the popup is up. the editor loads a
            // single LOD, so also recommend uploading the original file when
            // publishing to superspl.at.
            const pickLod = async (lodCounts: readonly number[]) => {
                this.events.fire('stopSpinner');
                try {
                    const result = await this.events.invoke('showPopup', {
                        type: 'okcancel',
                        header: i18n.t('popup.load-options-header'),
                        message: i18n.t('popup.lod-select-message'),
                        icon: false,
                        select: {
                            value: String(defaultLodIndex(lodCounts)),
                            options: lodCounts.map((count, i) => ({
                                v: String(i),
                                t: `LOD ${i} (${count.toLocaleString()} ${i18n.t('popup.lod-select-splats')})`
                            }))
                        },
                        warning: {
                            text: i18n.t('popup.lod-upload-note'),
                            link: `${window.location.origin}/upload`
                        }
                    });
                    return result.action === 'ok' ? parseInt(result.value, 10) : null;
                } finally {
                    this.events.fire('startSpinner');
                }
            };

            // Skip reordering for animation frames (speed) or when explicitly requested (already ordered)
            let result = await loadGSplatDataAsync(filename, fileSystem, skipReorder || animationFrame, animationFrame ? undefined : pickLod);
            if (!result) {
                // user cancelled LOD selection
                return null;
            }
            const { gsplatData, transform } = result;
            validateGSplatData(gsplatData);

            // Sanitize "giant grey splat" layers: neutral-grey, half-transparent
            // gaussians whose scale is far beyond the scene. Some pipelines /
            // source data produce them; rendering millions explodes fill-rate ->
            // GPU timeout (black screen) -> context loss (white UI). When they
            // dominate the model we ask: shrink (keep all, clamp scale — the
            // recommended default), remove (delete them), or keep as-is.
            if (sanitize) {
                const report = detectGiantGreySplats(gsplatData);
                if (report.removable) {
                    const popupResult = await this.events.invoke('showPopup', {
                        type: 'okcancel',
                        header: i18n.t('popup.giant-splat-header'),
                        message: i18n.t('popup.giant-splat-message', {
                            count: report.giantGrey.toLocaleString(),
                            pct: (100 * report.giantGrey / report.total).toFixed(0)
                        }),
                        icon: true,
                        warning: {
                            text: i18n.t('popup.giant-splat-warning')
                        },
                        buttons: [
                            { label: i18n.t('popup.giant-splat-shrink'), action: 'shrink' },
                            { label: i18n.t('popup.giant-splat-remove'), action: 'remove' },
                            { label: i18n.t('popup.giant-splat-keep'), action: 'keep' }
                        ]
                    });
                    if (popupResult.action === 'shrink') {
                        const shrunk = shrinkGiantGreySplats(gsplatData, report);
                        console.warn(`[splat-sanitize] shrunk ${shrunk.toLocaleString()} giant grey splats (scale clamped to sane size)`);
                    } else if (popupResult.action === 'remove') {
                        const cleaned = removeGiantGreySplats(gsplatData, report);
                        console.warn(`[splat-sanitize] removed ${cleaned.removed.toLocaleString()} giant grey splats from ${report.total.toLocaleString()}`);
                        result = { gsplatData: cleaned.data, transform };
                    }
                    // 'keep' (or dismiss) leaves the data untouched.
                }
            }

            const asset = this.createGSplatAsset(result.gsplatData, filename);

            return new Splat(asset, transform.rotation);
        } finally {
            if (!animationFrame) {
                this.events.fire('stopSpinner');
            }
        }
    }
}

export { AssetLoader };
