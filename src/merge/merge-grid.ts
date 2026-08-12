import {
    Application,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    BLENDEQUATION_ADD,
    BlendState,
    CULLFACE_NONE,
    DepthState,
    Entity,
    Layer,
    Mat4,
    QuadRender,
    SEMANTIC_POSITION,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Vec3
} from 'playcanvas';

import { vertexShader, fragmentShader } from './merge-grid-shader';

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

const vecA = new Vec3();
const vecB = new Vec3();

/**
 * 移植自主程序 InfiniteGrid 的无限网格（GPU shader）：
 * 10m 彩色主轴（红/绿/蓝）+ 1m / 0.1m 灰线 + 距离淡出 + 蓝噪声深度抖动。
 * 渲染挂在相机组件 preRenderLayer 事件上（不透明 World 层之前）。
 */
class MergeGrid {
    visible = true;
    private shader: Shader;
    private quadRender: QuadRender;
    private blendState: any;
    private app: Application;
    private camera: Entity;
    private worldLayerId: number;
    private view_position = [0, 0, 0];
    private viewProjectionMatrix = new Mat4();

    constructor(app: Application, camera: Entity, worldLayerId: number) {
        this.app = app;
        this.camera = camera;
        this.worldLayerId = worldLayerId;

        const device = app.graphicsDevice;

        this.shader = ShaderUtils.createShader(device, {
            uniqueName: 'merge-infinite-grid',
            attributes: {
                vertex_position: SEMANTIC_POSITION
            },
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });

        this.quadRender = new QuadRender(this.shader);

        this.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA
        );

        // plane: 1 = xz（merge 为透视轨道相机，网格固定在 XZ 平面）
        camera.camera.on('preRenderLayer', (layer: Layer, transparent: boolean) => {
            if (this.visible && layer.id === this.worldLayerId && !transparent) {
                device.setBlendState(this.blendState);
                device.setCullMode(CULLFACE_NONE);
                device.setDepthState(DepthState.WRITEDEPTH);
                device.setStencilState(null, null);

                resolve(device.scope, {
                    plane: 1,
                    view_position: this.view_position,
                    matrix_viewProjection: this.viewProjectionMatrix.data
                });

                this.quadRender.render();
            }
        });
    }

    /** 每帧更新相机相关 uniform（frustum 角点 + 视图投影矩阵）。 */
    updateCameraUniforms(): void {
        const device = this.app.graphicsDevice;
        const camComp = this.camera.camera;

        const set = (name: string, vec: Vec3) => {
            device.scope.resolve(name).setValue([vec.x, vec.y, vec.z]);
        };

        // frustum 角点（世界空间）
        const points = camComp.camera.getFrustumCorners(-100);
        const worldTransform = this.camera.getWorldTransform();
        for (let i = 0; i < points.length; i++) {
            worldTransform.transformPoint(points[i], points[i]);
        }

        // 透视相机：near 平面约等于视点
        set('near_origin', worldTransform.getTranslation());
        set('near_x', Vec3.ZERO);
        set('near_y', Vec3.ZERO);

        // far 平面
        set('far_origin', points[7]);
        set('far_x', vecA.sub2(points[4], points[7]));
        set('far_y', vecB.sub2(points[6], points[7]));

        // viewProjection + 观察位置（淡出用）
        this.viewProjectionMatrix.mul2(camComp.camera.projectionMatrix, camComp.camera.viewMatrix);
        const p = this.camera.getPosition();
        this.view_position[0] = p.x;
        this.view_position[1] = p.y;
        this.view_position[2] = p.z;
    }

    destroy(): void {
        this.shader.destroy();
        this.quadRender.destroy();
    }
}

export { MergeGrid };
