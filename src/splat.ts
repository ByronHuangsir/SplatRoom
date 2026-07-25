import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { Serializer } from './serializer';
import { vertexShader, fragmentShader, gsplatCenter } from './shaders/splat-shader';
import { State, SplatState } from './splat-state';
import { Transform } from './transform';
import { TransformPalette } from './transform-palette';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;
    worldBoundStorage: BoundingBox;

    _visible = true;
    transformPalette: TransformPalette;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;
    _highlights = 0;
    _shadows = 0;
    _contrast = 0;
    _colorGradeEnabled = true;
    _showDeleted = false;

    // HSL per-channel (8 zones: R, O, Y, G, A, B, P, M)
    _hslHue = new Float32Array(8);
    _hslSat = new Float32Array(8);
    _hslLum = new Float32Array(8);

    measurePoints: Vec3[] = [];
    measureSelection = -1;

    orientPoints: Vec3[] = [];
    orientSelection = -1;

    rebuildMaterial: (bands: number) => void;

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const { device } = asset.resource as GSplatResource;

        // create the entity once. its transform persists across frame swaps so
        // an animated sequence can replace its data without losing the user's
        // transform (see replaceData).
        this.entity = new Entity('splatEntity');

        this.selectionBoundStorage = new BoundingBox();

        // create the transform palette (reused across frame swaps; index 0 is identity)
        this.transformPalette = new TransformPalette(device);

        // rebuilds material chunks/params. reads the *current* gsplat instance and
        // state/transform textures so it remains valid after a replaceData swap
        // (the 'view.bands' listener registered in add() keeps pointing at it).
        this.rebuildMaterial = (bands: number) => {
            const instance = this.entity.gsplat.instance;
            const { material } = instance;
            const { glsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);

            material.setDefine('SH_BANDS', `${Math.min(bands, (instance.resource as GSplatResource).shBands)}`);
            material.setParameter('splatState', this.stateTexture);
            material.setParameter('splatTransform', this.transformTexture);
            material.update();

            material.setParameter('saturation', this._saturation);
            material.setParameter('highlights', this._highlights);
            material.setParameter('shadows', this._shadows);
            material.setParameter('contrast', this._contrast);
            material.setParameter('showDeleted', 0);
            material.setParameter('hslHueA', [this._hslHue[0], this._hslHue[1], this._hslHue[2], this._hslHue[3]]);
            material.setParameter('hslHueB', [this._hslHue[4], this._hslHue[5], this._hslHue[6], this._hslHue[7]]);
            material.setParameter('hslSatA', [this._hslSat[0], this._hslSat[1], this._hslSat[2], this._hslSat[3]]);
            material.setParameter('hslSatB', [this._hslSat[4], this._hslSat[5], this._hslSat[6], this._hslSat[7]]);
            material.setParameter('hslLumA', [this._hslLum[0], this._hslLum[1], this._hslLum[2], this._hslLum[3]]);
            material.setParameter('hslLumB', [this._hslLum[4], this._hslLum[5], this._hslLum[6], this._hslLum[7]]);
        };

        // bind the initial frame's data, applying the file's load rotation
        this.bindAsset(asset, rotation);
    }

    // bind a gsplat asset onto this element's entity: creates the gsplat
    // component, the per-splat state/transform channels and their gpu textures,
    // and caches the instance bounds. When `rotation` is supplied (initial load)
    // the entity rotation is set; on a frame swap it is omitted so the user's
    // transform is preserved.
    private bindAsset(asset: Asset, rotation?: Quat) {
        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData as GSplatData;
        const { device } = splatResource;

        this.asset = asset;
        this.splatData = splatData;
        this.numSplats = splatData.numSplats;

        // name and orientation are set on the initial bind only; a frame swap
        // (replaceData, no rotation) keeps the element's name and transform
        if (rotation) {
            this._name = (asset.file as any).filename;
            this.entity.setLocalRotation(rotation);
        }

        this.entity.addComponent('gsplat', {
            asset,
            unified: false
        });

        const instance = this.entity.gsplat.instance;

        // added per-splat state channel
        // bit 1: selected
        // bit 2: deleted
        // bit 3: locked
        if (!splatData.getProp('state')) {
            splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        splatData.getElement('vertex').properties.push({
            type: 'ushort',
            name: 'transform',
            storage: new Uint16Array(splatData.numSplats),
            byteSize: 2
        });

        const { x: width, y: height } = (splatResource as any).textureDimensions;

        // pack spherical harmonic data
        const createTexture = (name: string, format: number) => {
            return new Texture(device, {
                name: name,
                width: width,
                height: height,
                format: format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
        this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);

        this.localBoundStorage = instance.resource.aabb;
        // @ts-ignore
        this.worldBoundStorage = instance.meshInstance._aabb;

        // @ts-ignore
        instance.meshInstance._updateAabb = false;

        // when sort changes, re-render the scene
        instance.sorter.on('updated', () => {
            this.changedCounter++;
        });
    }

    // wait for the next scene render to complete, with a safety timeout so a
    // stalled render loop (e.g. a backgrounded tab where rAF is paused) can't
    // block frame swapping forever. In a live app postrender fires within a
    // frame, so the timeout never matters.
    private waitForRender(): Promise<void> {
        return new Promise((resolve) => {
            // single finish() removes the listener and clears the timeout, so the
            // common case (postrender fires first) doesn't leave a pending timer.
            const handles: { off?: { off: () => void }, timer?: ReturnType<typeof setTimeout> } = {};
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                handles.off?.off();
                clearTimeout(handles.timer);
                resolve();
            };
            handles.off = this.scene.events.on('postrender', finish);
            // safety: don't block frame swapping forever if the render loop is stalled
            handles.timer = setTimeout(finish, 200);
        });
    }

    // swap in a new frame's gsplat data while preserving this element's identity,
    // transform and visual properties. used by animated sequence playback so each
    // frame doesn't recreate the whole element.
    //
    // The gsplat lives on this.entity (read in many places), so we can't double
    // buffer on a child. Instead we bind the new frame to a *fresh* entity, sort
    // it, and let it render once alongside the still-present old entity before
    // destroying the old one. This overlap avoids a blank/unsorted frame
    // flickering on screen during the swap (the old frame masks the new one's
    // first sort), matching the previous per-frame load behaviour. The user's
    // transform is carried across so it persists.
    async replaceData(asset: Asset) {
        const oldEntity = this.entity;
        const oldAsset = this.asset;
        const oldStateTexture = this.stateTexture;
        const oldTransformTexture = this.transformTexture;

        // carry the current transform onto the new entity
        const position = oldEntity.getLocalPosition().clone();
        const rotation = oldEntity.getLocalRotation().clone();
        const scale = oldEntity.getLocalScale().clone();

        this.entity = new Entity('splatEntity');
        this.entity.setLocalPosition(position);
        this.entity.setLocalRotation(rotation);
        this.entity.setLocalScale(scale);

        // bind the new frame (no rotation: transform already applied above)
        this.bindAsset(asset);

        // add the new entity to the scene and configure its instance
        this.scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [this.scene.splatLayer.id];
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // refresh gpu state/counts/bounds, then wait for the new frame to render
        // before removing the old entity, which keeps the previous frame on screen
        // in the meantime. Skip the wait during offline video render
        // (lockedRenderMode): renders are gated on scene.lockedRender there, so
        // blocking on a render would deadlock — and the render loop sorts+captures
        // each frame deterministically anyway.
        await this.updateState(State.deleted);
        if (!this.scene.lockedRenderMode) {
            await this.waitForRender();
        }

        // notify dependents (e.g. the centers overlay, which parents itself under
        // this.entity) to re-bind to the new entity/instance before the old entity
        // is destroyed — otherwise they're torn down with it and never re-attach
        // (no selection.changed fires on a frame swap).
        this.scene.events.fire('splat.replaced', this);

        // tear down the previous frame
        oldEntity.destroy();
        oldStateTexture.destroy();
        oldTransformTexture.destroy();
        oldAsset.registry?.remove(oldAsset);
        oldAsset.unload();

        this.changedCounter++;
        this.scene.forceRender = true;
    }

    destroy() {
        super.destroy();
        this.entity.destroy();
        this.asset.registry.remove(this.asset);
        this.asset.unload();
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else {
            await this.updateLocalBounds();
        }

        this.scene.forceRender = true;
        this.scene.events.fire('splat.stateChanged', this);
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;
        for (let i = 0; i < this.splatData.numSplats; ++i) {
            if (state[i] === State.selected) {
                centers[i * 3 + 0] = data[i * 4];
                centers[i * 3 + 1] = data[i * 4 + 1];
                centers[i * 3 + 2] = data[i * 4 + 2];
            }
        }

        await this.updateSorting();

        this.scene.forceRender = true;
        this.scene.events.fire('splat.positionsChanged', this);
    }

    async updateSorting() {
        const state = this.splatData.getProp('state') as Uint8Array;

        let mapping;

        // create a sorter mapping to remove deleted splats (unless showDeleted is on)
        if (this.numSplats !== state.length && !this._showDeleted) {
            mapping = new Uint32Array(this.numSplats);
            let idx = 0;
            for (let i = 0; i < state.length; ++i) {
                if ((state[i] & State.deleted) === 0) {
                    mapping[idx++] = i;
                }
            }
        }

        // update sorting instance
        this.entity.gsplat.instance.sorter.setMapping(mapping);

        // recalculate bounds after sorting changes
        await this.updateLocalBounds();
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            this.scene.events.fire('splat.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
        serializer.pack(this.highlights, this.shadows, this.contrast);
        serializer.pack(this.colorGradeEnabled ? 1 : 0);
        serializer.packa(Array.from(this._hslHue));
        serializer.packa(Array.from(this._hslSat));
        serializer.packa(Array.from(this._hslLum));
    }

    onPreRender() {
        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        const cameraMode = events.invoke('camera.mode');
        const cameraOverlay = events.invoke('camera.overlay');

        // configure rings rendering
        const material = this.entity.gsplat.instance.material;
        material.setParameter('outlineMode', events.invoke('view.outlineSelection') ? 1 : 0);
        material.setParameter('ringSize', (selected && cameraOverlay && cameraMode === 'rings') ? 0.04 : 0);

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        if (!selected) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else if (events.invoke('view.outlineSelection')) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else {
            material.setParameter('selectedClr', [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a * this.selectionAlpha]);
        }
        material.setParameter('unselectedClr', [unselectedClr.r, unselectedClr.g, unselectedClr.b, unselectedClr.a]);
        material.setParameter('lockedClr', [lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a]);

        // combine black pointer, white point and brightness
        if (this._colorGradeEnabled) {
            const offset = -this.blackPoint + this.brightness;
            const denom = Math.max(0.001, this.whitePoint - this.blackPoint);
            const scale = 1 / denom;

            material.setParameter('clrOffset', [offset, offset, offset]);
            material.setParameter('clrScale', [
                scale * this.tintClr.r * (1 + this.temperature),
                scale * this.tintClr.g,
                scale * this.tintClr.b * (1 - this.temperature),
                this.transparency
            ]);

            material.setParameter('saturation', this.saturation);
            material.setParameter('highlights', this.highlights);
            material.setParameter('shadows', this.shadows);
            material.setParameter('contrast', this.contrast);
            material.setParameter('showDeleted', this._showDeleted ? 1 : 0);
            material.setParameter('hslHueA', [this._hslHue[0], this._hslHue[1], this._hslHue[2], this._hslHue[3]]);
            material.setParameter('hslHueB', [this._hslHue[4], this._hslHue[5], this._hslHue[6], this._hslHue[7]]);
            material.setParameter('hslSatA', [this._hslSat[0], this._hslSat[1], this._hslSat[2], this._hslSat[3]]);
            material.setParameter('hslSatB', [this._hslSat[4], this._hslSat[5], this._hslSat[6], this._hslSat[7]]);
            material.setParameter('hslLumA', [this._hslLum[0], this._hslLum[1], this._hslLum[2], this._hslLum[3]]);
            material.setParameter('hslLumB', [this._hslLum[4], this._hslLum[5], this._hslLum[6], this._hslLum[7]]);
        } else {
            // bypass all color grading — neutral values
            material.setParameter('clrOffset', [0, 0, 0]);
            material.setParameter('clrScale', [1, 1, 1, 1]);
            material.setParameter('saturation', 1);
            material.setParameter('highlights', 0);
            material.setParameter('shadows', 0);
            material.setParameter('contrast', 0);
            material.setParameter('showDeleted', this._showDeleted ? 1 : 0);
            material.setParameter('hslHueA', [0, 0, 0, 0]);
            material.setParameter('hslHueB', [0, 0, 0, 0]);
            material.setParameter('hslSatA', [0, 0, 0, 0]);
            material.setParameter('hslSatB', [0, 0, 0, 0]);
            material.setParameter('hslLumA', [0, 0, 0, 0]);
            material.setParameter('hslLumB', [0, 0, 0, 0]);
        }
        material.setParameter('transformPalette', this.transformPalette.texture);

        if (this.visible && selected) {
            // render bounding box
            if (events.invoke('camera.bound')) {
                const bound = this.localBound;
                const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
                scale.mul2(this.entity.getWorldTransform(), scale);

                for (let i = 0; i < boundingPoints.length / 2; i++) {
                    const a = boundingPoints[i * 2];
                    const b = boundingPoints[i * 2 + 1];
                    scale.transformPoint(a, veca);
                    scale.transformPoint(b, vecb);

                    this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
                }
            }
        }

        this.entity.enabled = this.visible;
    }

    focalPoint() {
        const data = this.splatData;
        if (!data) {
            return this.worldBound.center;
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        // fall back to AABB center if any required channel is missing
        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.center;
        }

        let sumX = 0, sumY = 0, sumZ = 0;
        let totalWeight = 0;

        for (let i = 0; i < numSplats; i++) {
            // opacity is stored in raw (pre-sigmoid) log space, apply sigmoid
            // to get [0,1] range. scale is in log space, exp() gives linear size.
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            sumX += x[i] * w;
            sumY += y[i] * w;
            sumZ += z[i] * w;
            totalWeight += w;
        }

        const result = new Vec3();
        if (totalWeight > 0) {
            result.set(sumX / totalWeight, sumY / totalWeight, sumZ / totalWeight);
        } else {
            return this.worldBound.center;
        }

        // transform from local space to world space
        this.entity.getWorldTransform().transformPoint(result, result);

        return result;
    }

    denseRadius() {
        // Compute a density-weighted radius that covers the concentrated region.
        // Uses weighted standard deviation of positions, with the same alpha*scale
        // weighting as focalPoint(). Returns 3× the max weighted stddev, which
        // captures ~99% of the concentrated Gaussians.
        const data = this.splatData;
        if (!data) {
            return this.worldBound.halfExtents.length();
        }

        const numSplats = data.numSplats;
        const x = data.getProp('x') as Float32Array;
        const y = data.getProp('y') as Float32Array;
        const z = data.getProp('z') as Float32Array;
        const opacity = data.getProp('opacity') as Float32Array;
        const sx = data.getProp('scale_0') as Float32Array;
        const sy = data.getProp('scale_1') as Float32Array;
        const sz = data.getProp('scale_2') as Float32Array;

        if (!x || !y || !z || !opacity || !sx || !sy || !sz) {
            return this.worldBound.halfExtents.length();
        }

        // First pass: compute weighted mean
        let totalWeight = 0;
        let meanX = 0, meanY = 0, meanZ = 0;
        // Use sampling for huge models (>500k points) to avoid blocking
        const stride = numSplats > 500000 ? Math.ceil(numSplats / 200000) : 1;

        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            meanX += x[i] * w;
            meanY += y[i] * w;
            meanZ += z[i] * w;
            totalWeight += w;
        }

        if (totalWeight === 0) {
            return this.worldBound.halfExtents.length();
        }

        meanX /= totalWeight;
        meanY /= totalWeight;
        meanZ /= totalWeight;

        // Second pass: compute weighted variance
        let varX = 0, varY = 0, varZ = 0;
        for (let i = 0; i < numSplats; i += stride) {
            const op = 1 / (1 + Math.exp(-opacity[i]));
            const w = op / (1 + Math.exp(Math.max(sx[i], sy[i], sz[i])));
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            const dz = z[i] - meanZ;
            varX += dx * dx * w;
            varY += dy * dy * w;
            varZ += dz * dz * w;
        }

        varX /= totalWeight;
        varY /= totalWeight;
        varZ /= totalWeight;

        // 3× sigma covers ~99% of concentrated Gaussians
        const sigma = 3;
        const radius = sigma * Math.sqrt(Math.max(varX, varY, varZ));

        // scale by world transform (uniform scale approximation)
        const worldScale = this.entity.getWorldTransform().getScale();
        return Math.max(radius * (worldScale.x + worldScale.y + worldScale.z) / 3, 0.001);
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.updateWorldBound();

        this.scene.events.fire('splat.moved', this);
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage);
        this.updateWorldBound();
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        this.scene.boundDirty = true;
    }

    // get the selection bound
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set showDeleted(value: boolean) {
        if (value !== this._showDeleted) {
            this._showDeleted = value;
            // update sorter mapping to include/exclude deleted points
            this.updateSorting();
            this.scene.forceRender = true;
            this.scene?.events.fire('splat.showDeleted', this);
        }
    }

    get showDeleted() {
        return this._showDeleted;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.scene.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.scene.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.scene.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.scene.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.scene.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.scene.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.scene.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    set highlights(value: number) {
        if (value !== this._highlights) {
            this._highlights = value;
            this.scene.events.fire('splat.highlights', this);
        }
    }

    get highlights() {
        return this._highlights;
    }

    set shadows(value: number) {
        if (value !== this._shadows) {
            this._shadows = value;
            this.scene.events.fire('splat.shadows', this);
        }
    }

    get shadows() {
        return this._shadows;
    }

    set contrast(value: number) {
        if (value !== this._contrast) {
            this._contrast = value;
            this.scene.events.fire('splat.contrast', this);
        }
    }

    get contrast() {
        return this._contrast;
    }

    set hslHue(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslHue[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslHue', this);
    }

    get hslHue() {
        return this._hslHue;
    }

    set hslSat(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslSat[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslSat', this);
    }

    get hslSat() {
        return this._hslSat;
    }

    set hslLum(value: ArrayLike<number>) {
        for (let i = 0; i < 8; i++) this._hslLum[i] = value[i] ?? 0;
        this.scene.events.fire('splat.hslLum', this);
    }

    get hslLum() {
        return this._hslLum;
    }

    set colorGradeEnabled(value: boolean) {
        if (value !== this._colorGradeEnabled) {
            this._colorGradeEnabled = value;
            this.scene.events.fire('splat.colorGradeEnabled', this);
        }
    }

    get colorGradeEnabled() {
        return this._colorGradeEnabled;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(mode: 'center' | 'boundCenter', selection: boolean, result: Transform) {
        const { entity } = this;
        switch (mode) {
            case 'center':
                result.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
                break;
            case 'boundCenter': {
                const bound = selection ? this.selectionBound : this.localBound;
                entity.getLocalTransform().transformPoint(bound.center, vec);
                result.set(vec, entity.getLocalRotation(), entity.getLocalScale());
                break;
            }
        }
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            visible: this.visible,
            tintClr: packC(this.tintClr),
            temperature: this.temperature,
            saturation: this.saturation,
            brightness: this.brightness,
            blackPoint: this.blackPoint,
            whitePoint: this.whitePoint,
            transparency: this.transparency,
            highlights: this.highlights,
            shadows: this.shadows,
            contrast: this.contrast,
            colorGradeEnabled: this.colorGradeEnabled,
            hslHue: Array.from(this._hslHue),
            hslSat: Array.from(this._hslSat),
            hslLum: Array.from(this._hslLum)
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency, highlights, shadows, contrast, colorGradeEnabled, hslHue, hslSat, hslLum } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        this.visible = visible;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3]);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        this.brightness = brightness;
        this.blackPoint = blackPoint;
        this.whitePoint = whitePoint;
        this.transparency = transparency;
        this.highlights = highlights ?? 0;
        this.shadows = shadows ?? 0;
        this.contrast = contrast ?? 0;
        this.colorGradeEnabled = colorGradeEnabled ?? true;
        if (hslHue) this.hslHue = hslHue;
        if (hslSat) this.hslSat = hslSat;
        if (hslLum) this.hslLum = hslLum;
    }
}

export { Splat };
