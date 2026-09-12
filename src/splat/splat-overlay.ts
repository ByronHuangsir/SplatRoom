import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    CULLFACE_NONE,
    FILTER_NEAREST,
    PIXELFORMAT_R32U,
    PRIMITIVE_POINTS,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_POSITION,
    TYPE_FLOAT32,
    Color,
    Entity,
    EventHandler,
    GSplatResource,
    ShaderMaterial,
    Mesh,
    Mat4,
    MeshInstance,
    Texture,
    VertexBuffer,
    VertexFormat
} from 'playcanvas';

import { buildGpuProjection } from './gpu-projection';
import { Splat } from './splat';
import { ElementType, Element } from '../scene/element';
import { vertexShader, fragmentShader } from '../shaders/splat-overlay-shader';

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
    // (a load that hasn't finished setting the instance up): the overlay renders
    // nothing until it becomes ready
    orderReady = false;
    // reused scratch matrix for the WebGPU view-projection material parameter
    private viewProjMat = new Mat4();

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
        // WGSL has no point size, and a vertex shader that assigns gl_PointSize loses its
        // entry point when it is transpiled to WGSL (invalid pipeline on the WebGPU
        // backend). Define the guard there so the shader expands each center into a
        // screen-space quad instead, which gives the same on-screen size.
        if (device.isWebGPU) {
            this.material.setDefine('GSPLAT_QUAD_SPRITES', '');
            // the engine's mesh/view uniform buffers are not bound correctly for these
            // custom materials on WebGPU, so take the transform from material parameters
            // (the same workaround the splat material uses via uSplatView/uSplatViewProj)
            this.material.setDefine('GSPLAT_OVERLAY_PARAM_MATRICES', '');
            // each center is drawn as a quad there (six vertices per splat)
            this.quadSprites = true;
        }

        this.material.blendType = BLEND_NORMAL;
        this.material.depthWrite = false;
        this.material.depthTest = true;
        if (device.isWebGPU) {
            // the sprite quads are built in clip space, so their winding is not meaningful
            this.material.cull = CULLFACE_NONE;
        }
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
            type: device.isWebGPU ? PRIMITIVE_TRIANGLES : PRIMITIVE_POINTS,
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

    // WebGPU draws each center as a quad, so the mesh needs six vertices per center
    // (see GSPLAT_QUAD_SPRITES in the shader)
    drawPoints = 0;

    private quadSprites = false;

    // WebGPU only: the order texture the overlay's shader reads. The engine sorts into a
    // storage buffer on that backend and provides no order texture, so this is seeded with
    // the identity mapping (splat i in slot i) and then left alone: mirroring the real
    // sorted order cost a ~20 MB upload per sort (measured: 180 MB/s while orbiting a 5M
    // splat model), while center dots do not depend on the draw order at all. Built on
    // demand (four bytes per splat) so it only exists while centers are actually drawn.
    private gpuOrderTexture: Texture | null = null;

    private ensureGpuOrderTexture() {
        const dims = (this.splat?.entity as any)?.gsplat?.instance?.resource?.textureDimensions;
        if (!dims) {
            return null;
        }
        if (this.gpuOrderTexture &&
            this.gpuOrderTexture.width === dims.x &&
            this.gpuOrderTexture.height === dims.y) {
            return this.gpuOrderTexture;
        }

        this.gpuOrderTexture?.destroy();
        const texture = new Texture(this.scene.graphicsDevice, {
            name: 'splatOrderOverlay',
            width: dims.x,
            height: dims.y,
            format: PIXELFORMAT_R32U,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        const data = texture.lock() as Uint32Array;
        for (let i = 0; i < data.length; i++) {
            data[i] = i;
        }
        texture.unlock();

        this.gpuOrderTexture = texture;
        return texture;
    }

    private setDrawCount(count: number) {
        this.drawPoints = count;
        this.mesh.primitive[0].count = count * (this.quadSprites ? 6 : 1);
    }

    attach(splat: Splat) {
        // detach from previous splat first
        this.detach();

        const { mesh, material } = this;
        const instance = (splat.entity as any).gsplat?.instance;

        // the instance's order texture only exists on WebGL2 (WebGPU sorts into a
        // storage buffer instead and the overlay builds its own mirror on demand) and its
        // sorter is created lazily, so a splat can be attached while its instance is not
        // renderable here yet (selection lands before the load finishes, or a proxy/LOD
        // instance swapped in by replaceData). keep the splat and retry from onUpdate
        // instead of throwing on undefined.width, which would abort the whole load.
        const orderTexture: Texture = instance?.orderTexture ?? null;
        const isWebGPU = this.scene.graphicsDevice.isWebGPU;
        if (!instance || !instance.sorter || !instance.resource || !splat.stateTexture ||
            (!isWebGPU && !orderTexture)) {
            this.splat = splat;
            this.orderReady = false;
            return;
        }

        // set up order texture uniforms (WebGL2 only: WebGPU indexes splats directly)
        if (!isWebGPU) {
            material.setParameter('splatOrder', orderTexture);
            material.setParameter('splatTextureSize', orderTexture.width);
        }

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
            // WebGL2 draws the sorter's visible prefix of its (sorted) order texture. The
            // WebGPU identity texture maps draw index to splat index, so the sorter's count
            // would describe a different set of indices there — draw every splat instead
            // (off-screen ones are clipped).
            if (!isWebGPU) {
                this.setDrawCount(instance.sorter.pendingSorted?.count ?? this.drawPoints);
            }
        };
        this.sorter = instance.sorter;
        this.sorter.on('updated', this.onSorterUpdated);

        // initialize count - numSplats is the current visible count (excluding deleted)
        this.setDrawCount(splat.numSplats);

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

        // release the identity order texture (rebuilt on demand, four bytes per splat)
        this.gpuOrderTexture?.destroy();
        this.gpuOrderTexture = null;

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

            // WebGPU: the transform comes from material parameters (see add()). The camera
            // component's own matrices are not usable this early in the frame — the engine
            // refreshes them lazily when it syncs the render view — so build the
            // view-projection here, the same way Splat.updateGpuCameraUniforms does.
            if (scene.graphicsDevice.isWebGPU) {
                // the identity order texture is only needed for the frames we actually draw
                const orderTexture = this.ensureGpuOrderTexture();
                if (orderTexture) {
                    material.setParameter('splatOrder', orderTexture);
                    material.setParameter('splatTextureSize', orderTexture.width);
                }

                const cam = (scene.camera as any)?.camera;
                if (cam) {
                    const size = (scene.camera as any).targetSize ?? { width: 1, height: 1 };
                    buildGpuProjection(this.viewProjMat, cam);
                    this.viewProjMat.mul2(this.viewProjMat, cam.viewMatrix);
                    material.setParameter('uOverlayViewProj', this.viewProjMat.data);
                    material.setParameter('uOverlayModel', this.splat.entity.getWorldTransform().data);
                    // the sprite quads are sized in pixels, so they need the render
                    // target resolution (same pixels gl_PointSize works in on WebGL2)
                    material.setParameter('uOverlayViewportSize', [size.width, size.height]);
                }
            }
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
