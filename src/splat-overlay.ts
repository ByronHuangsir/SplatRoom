import {
    BLEND_NORMAL,
    PRIMITIVE_POINTS,
    SEMANTIC_POSITION,
    TYPE_FLOAT32,
    Color,
    Entity,
    EventHandler,
    GSplatResource,
    ShaderMaterial,
    Mesh,
    MeshInstance,
    VertexBuffer,
    VertexFormat
} from 'playcanvas';

import { ElementType, Element } from './element';
import { vertexShader, fragmentShader } from './shaders/splat-overlay-shader';
import { Splat } from './splat';

const nullClr = new Color(0, 0, 0, 0);

class SplatOverlay extends Element {
    entity: Entity;
    mesh: Mesh;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
    splat: Splat;
    onSorterUpdated: (count: number) => void;
    // the sorter we subscribed to in attach(); cached so detach() unsubscribes
    // from it directly (splat.entity may have been swapped out by replaceData)
    sorter: EventHandler;
    // false while the attached splat's instance has no sorter/order texture yet
    // (WebGPU backend, or a load that hasn't finished setting the instance up):
    // the overlay renders nothing until it becomes ready
    orderReady = false;
    // one-shot note so the WebGPU case is reported once, not every frame
    warnedNoOrderTexture = false;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;

        this.material = new ShaderMaterial({
            uniqueName: 'splatOverlayMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.blendType = BLEND_NORMAL;
        this.material.depthWrite = false;
        this.material.depthTest = true;
        this.material.update();

        this.mesh = new Mesh(device);

        // dummy 1-vertex VB so the engine caches the VAO (avoids creating a new one every frame)
        const format = new VertexFormat(device, [
            { semantic: SEMANTIC_POSITION, components: 1, type: TYPE_FLOAT32 }
        ]);
        format.instancing = true;
        const vb = new VertexBuffer(device, format, 1);
        vb.lock();
        vb.unlock();
        this.mesh.vertexBuffer = vb;

        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_POINTS,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        // slightly higher priority so it renders before gizmos
        this.meshInstance.drawBucket = 128;
        // disable frustum culling since mesh has no vertex buffer for AABB calculation
        this.meshInstance.cull = false;

        this.entity = new Entity('splatOverlay');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.gizmoLayer.id]
        });

        scene.events.on('selection.changed', (selection: Splat) => {
            if (selection) {
                this.attach(selection);
            } else {
                this.detach();
            }
        });

        // re-attach when the attached splat swaps its frame data (animated
        // sequence): replaceData builds a new entity/instance, so our captured
        // instance and our entity (parented under the old one) are stale.
        scene.events.on('splat.replaced', (splat: Splat) => {
            if (this.splat === splat) {
                this.attach(splat);
            }
        });
    }

    destroy() {
        this.detach();
        this.entity.destroy();
    }

    attach(splat: Splat) {
        // detach from previous splat first
        this.detach();

        const { mesh, material } = this;
        const instance = (splat.entity as any).gsplat?.instance;

        // the instance's order texture only exists on WebGL2 (WebGPU uses an
        // order storage buffer instead) and its sorter is created lazily, so a
        // splat can be attached while its instance is not renderable here yet
        // (selection lands before the load finishes, or a proxy/LOD instance
        // swapped in by replaceData). keep the splat and retry from
        // onPreRender instead of throwing on undefined.width, which would abort
        // the whole load.
        if (!instance || !instance.sorter || !instance.orderTexture || !instance.resource || !splat.stateTexture) {
            // on WebGPU the order data lives in a storage buffer, so this
            // overlay can never run there: say so once instead of leaving the
            // user wondering why centers are missing
            if (!this.warnedNoOrderTexture && this.scene.graphicsDevice.isWebGPU) {
                this.warnedNoOrderTexture = true;
                console.warn('[SplatOverlay] centers overlay is unavailable on the WebGPU backend (no order texture)');
            }
            this.splat = splat;
            this.orderReady = false;
            return;
        }

        const orderTexture = instance.orderTexture;

        // set up order texture uniforms
        material.setParameter('splatOrder', orderTexture);
        material.setParameter('splatTextureSize', orderTexture.width);

        // set up other uniforms
        const resource = instance.resource as GSplatResource;
        material.setParameter('splatState', splat.stateTexture);
        material.setParameter('splatPosition', (resource as any).getTexture('transformA'));
        material.setParameter('splatTransform', splat.transformTexture);
        material.setParameter('splatColor', (resource as any).getTexture('splatColor'));
        material.setParameter('texParams', [splat.stateTexture.width, splat.stateTexture.height]);

        // set up SH textures and define based on SH bands
        const shBands = resource.shBands;
        material.setDefine('SH_BANDS', `${shBands}`);
        if (shBands > 0) {
            material.setParameter('splatSH_1to3', (resource as any).getTexture('splatSH_1to3'));
            if (shBands > 1) {
                material.setParameter('splatSH_4to7', (resource as any).getTexture('splatSH_4to7'));
                material.setParameter('splatSH_8to11', (resource as any).getTexture('splatSH_8to11'));
                if (shBands > 2) {
                    material.setParameter('splatSH_12to15', (resource as any).getTexture('splatSH_12to15'));
                }
            }
        }

        material.update();

        // subscribe to sorter updates for dynamic count, caching the sorter so
        // detach() can unsubscribe from this exact instance
        this.onSorterUpdated = () => {
            mesh.primitive[0].count = instance.sorter.pendingSorted?.count ?? mesh.primitive[0].count;
        };
        this.sorter = instance.sorter;
        this.sorter.on('updated', this.onSorterUpdated);

        // initialize count - numSplats is the current visible count (excluding deleted)
        mesh.primitive[0].count = splat.numSplats;

        splat.entity.addChild(this.entity);
        this.splat = splat;
        this.orderReady = true;
    }

    detach() {
        // unsubscribe from the cached sorter (not splat.entity, which replaceData
        // may have already swapped to a new entity/instance)
        if (this.sorter && this.onSorterUpdated) {
            this.sorter.off('updated', this.onSorterUpdated);
        }
        this.sorter = null;
        this.onSorterUpdated = null;

        this.entity.remove();
        this.splat = null;
        this.orderReady = false;
    }

    // a splat attached before its instance was renderable becomes drawable as
    // soon as the sorter / order texture exist (the engine creates the sorter
    // lazily, a frame or two later). the retry lives in onUpdate because the
    // scene skips render frames when nothing changed (app.autoRender = false),
    // so onPreRender is not guaranteed to run while we wait.
    onUpdate() {
        if (this.splat && !this.orderReady) {
            this.attach(this.splat);
            if (this.orderReady) {
                this.scene.forceRender = true;
            }
        }
    }

    onPreRender() {
        const { enabled, scene } = this;
        const { events } = scene;

        this.entity.enabled = enabled;

        if (enabled) {
            const { material } = this;
            const splatSize = events.invoke('camera.splatSize');
            const selectedClr = events.invoke('view.outlineSelection') ? nullClr : events.invoke('selectedClr');
            const unselectedClr = events.invoke('unselectedClr');
            const useGaussianColor = events.invoke('view.centersUseGaussianColor') ? 1.0 : 0.0;

            material.setParameter('splatSize', splatSize * window.devicePixelRatio);
            material.setParameter('selectedClr', [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a]);
            material.setParameter('unselectedClr', [unselectedClr.r, unselectedClr.g, unselectedClr.b, unselectedClr.a]);
            material.setParameter('useGaussianColor', useGaussianColor);
            material.setParameter('transformPalette', this.splat.transformPalette.texture);

            // pass camera position for SH evaluation
            const camPos = scene.camera.mainCamera.getPosition();
            material.setParameter('view_position', [camPos.x, camPos.y, camPos.z]);
        }
    }

    get enabled() {
        const { scene, splat } = this;
        const { events } = scene;
        return !!this.orderReady &&
            splat &&
            events.invoke('camera.splatSize') > 0 &&
            scene.camera.renderOverlays &&
            events.invoke('camera.overlay') &&
            events.invoke('camera.mode') === 'centers';
    }
}

export { SplatOverlay };
