import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_FRONT,
    BlendState,
    BoundingBox,
    Entity,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { applyFragCoordDefine } from '../core/gpu-backend';
import { Serializer } from '../core/serializer';
import { vertexShader, fragmentShader } from '../shaders/sphere-shape-shader';

const v = new Vec3();
const bound = new BoundingBox();

class SphereShape extends Element {
    _radius = 1;
    pivot: Entity;
    material: ShaderMaterial;

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('spherePivot');
        this.pivot.addComponent('render', {
            type: 'box'
        });
        const r = this._radius * 2;
        this.pivot.setLocalScale(r, r, r);
    }

    add() {
        // the material is built once and reused: add() runs on every activation of the
        // selection tool, so re-creating it leaked a material (and re-transpiled its
        // shader on WebGPU) on every toggle
        if (!this.material) {
            const material = new ShaderMaterial({
                uniqueName: 'sphereShape',
                vertexGLSL: vertexShader,
                fragmentGLSL: fragmentShader
            });
            material.cull = CULLFACE_FRONT;
            material.blendState = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
            applyFragCoordDefine(material, this.scene.graphicsDevice);
            material.update();

            this.material = material;
        }

        this.pivot.render.meshInstances[0].material = this.material;
        this.pivot.render.layers = [this.scene.worldLayer.id];

        this.scene.contentRoot.addChild(this.pivot);

        this.updateBound();
    }

    remove() {
        this.scene.contentRoot.removeChild(this.pivot);
        this.scene.boundDirty = true;
    }

    destroy() {

    }

    serialize(serializer: Serializer): void {
        serializer.packa(this.pivot.getWorldTransform().data);
        serializer.pack(this.radius);
    }

    onPreRender() {
        this.pivot.getWorldTransform().getTranslation(v);
        this.material.setParameter('sphere', [v.x, v.y, v.z, this.radius]);

        // 必须与 box-shape.ts 用同一个尺寸：片元着色器用 `gl_FragCoord / targetSize` 还原世界射线，
        // 所以这里是**实际光栅化目标**的像素尺寸（camera.targetSize 含交互期降级的 override），
        // 不是画布尺寸。写错会让球体的网格画成错位的重影（同 box-shape.ts 的长注释）。
        const device = this.scene.graphicsDevice;
        const size = this.scene.camera?.targetSize ?? { width: device.width, height: device.height };
        device.scope.resolve('targetSize').setValue([size.width, size.height]);
    }

    moved() {
        this.updateBound();
    }

    updateBound() {
        bound.center.copy(this.pivot.getPosition());
        bound.halfExtents.set(this.radius, this.radius, this.radius);

        // undo/redo can change the volume while it's not in the scene
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    get worldBound(): BoundingBox | null {
        return bound;
    }

    set radius(radius: number) {
        this._radius = radius;

        const r = this._radius * 2;
        this.pivot.setLocalScale(r, r, r);

        this.updateBound();
    }

    get radius() {
        return this._radius;
    }
}

export { SphereShape };
