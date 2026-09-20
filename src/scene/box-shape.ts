import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_FRONT,
    BlendState,
    BoundingBox,
    Entity,
    Mat4,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';
import { applyFragCoordDefine } from '../core/gpu-backend';
import { Serializer } from '../core/serializer';
import { vertexShader, fragmentShader } from '../shaders/box-shape-shader';

const invMat = new Mat4();
const bound = new BoundingBox();

// the pivot's local scale carries the box lengths, so in the pivot's local
// space the box is the unit cube
const unitBound = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.5, 0.5));

class BoxShape extends Element {
    _lenX = 2;
    _lenY = 2;
    _lenZ = 2;
    pivot: Entity;
    material: ShaderMaterial;

    constructor() {
        super(ElementType.debug);

        this.pivot = new Entity('boxPivot');
        this.pivot.addComponent('render', {
            type: 'box'
        });
    }

    add() {
        // the material is built once and reused: add() runs on every activation of the
        // selection tool, so re-creating it leaked a material (and re-transpiled its
        // shader on WebGPU) on every toggle
        if (!this.material) {
            const material = new ShaderMaterial({
                uniqueName: 'boxShape',
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
        serializer.pack(this.lenX);
        serializer.pack(this.lenY);
        serializer.pack(this.lenZ);
    }

    onPreRender() {
        this.pivot.setLocalScale(this._lenX, this._lenY, this._lenZ);
        invMat.copy(this.pivot.getWorldTransform()).invert();
        this.material.setParameter('boxInvMat', invMat.data);
        this.material.setParameter('boxLen', [this._lenX * 0.5, this._lenY * 0.5, this._lenZ  * 0.5]);

        // `targetSize` 是给片元着色器把 `gl_FragCoord` 还原成世界射线用的（`clip = fragCoord /
        // targetSize`，见 box-shape-shader.ts），所以它必须是**这个 pass 真正光栅化进去的那个
        // render target 的像素尺寸**。
        //
        // 2026-09-21 修：原来写的是 `device.width/height`（画布尺寸）。在没有缩放渲染目标时两者
        // 相等，所以一直没暴露；交互期降级会把主 render target 缩到 camera.targetSizeOverride
        // ⇒ 射线是按错误的像素位置还原的，方块的网格/棱线会画成一份**错位的重影**
        // （用户报"选区在移动/旋转视角时会在右上方形成一个虚影"）。用 camera.targetSize 读取即可
        // ——它已经包含 override（camera.ts 的 get targetSize），无 override 时与原值一致。
        const device = this.scene.graphicsDevice;
        const size = this.scene.camera?.targetSize ?? { width: device.width, height: device.height };
        device.scope.resolve('targetSize').setValue([size.width, size.height]);
    }

    moved() {
        this.updateBound();
    }

    updateBound() {
        // keep the pivot's scale in sync immediately (not just at the next
        // prerender) so world-transform reads are never stale
        this.pivot.setLocalScale(this._lenX, this._lenY, this._lenZ);
        bound.setFromTransformedAabb(unitBound, this.pivot.getWorldTransform());

        // undo/redo can change the volume while it's not in the scene
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    get worldBound(): BoundingBox | null {
        return bound;
    }

    set lenX(lenX: number) {
        this._lenX = lenX;
        this.updateBound();
    }

    get lenX() {
        return this._lenX;
    }

    set lenY(lenY: number) {
        this._lenY = lenY;
        this.updateBound();
    }

    get lenY() {
        return this._lenY;
    }

    set lenZ(lenZ: number) {
        this._lenZ = lenZ;
        this.updateBound();
    }

    get lenZ() {
        return this._lenZ;
    }
}

export { BoxShape };
