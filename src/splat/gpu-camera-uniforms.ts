import { Mat4, PROJECTION_ORTHOGRAPHIC } from 'playcanvas';

import { buildGpuProjection } from './gpu-projection';

// On WebGPU the splat material does not read the engine's view uniform buffer; it takes its
// camera from material parameters instead (see splat-shader-wgsl.ts and the notes in
// splat.ts). Those parameters belong to the MATERIAL, which is shared by everything that
// draws the model - so whichever camera is rendered last wins. The main view used to be the
// only consumer; the picture-in-picture preview renders the same instances from the animation
// camera, and without re-uploading the parameters for that camera the preview came out as a
// copy of the main viewport instead of the camera it is supposed to preview.
//
// Anything that renders the splat material from another camera must therefore write the
// parameters for that camera and write the main view's back afterwards.
const projMat = new Mat4();
const viewProjMat = new Mat4();

// M2-3：uSplatCameraParams / uSplatViewport 的复用数组（以前每次调用各 new 一个）。
// 走缓存时缓存内部会拷到自己的持久副本，这两个只是源；不走缓存时直接交给
// setParameter —— 引擎每帧从 material.parameters 读值，内容下一帧才被覆盖，安全。
const cameraParams4 = [0, 0, 0, 0];
const viewport4 = [0, 0, 0, 0];

type ParamCache = {
    setArray: (material: any, name: string, values: ArrayLike<number>) => void;
};

type GpuCameraSource = {
    camera: {
        viewMatrix: Mat4;
        nearClip: number;
        farClip: number;
        aspectRatio: number;
        fov: number;
        horizontalFov: boolean;
        projection: number;
        orthoHeight: number;
    };
    targetSize?: { width: number, height: number };
};

const writeGpuCameraUniforms = (instance: { material?: { setParameter: (name: string, value: any) => void } } | null | undefined, source: GpuCameraSource | null | undefined, cache?: ParamCache) => {
    const cam = source?.camera;
    const material = instance?.material;
    if (!cam || !material) {
        return;
    }

    const near = cam.nearClip;
    const far = cam.farClip;
    const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
    const { width, height } = source.targetSize ?? { width: 1, height: 1 };

    // The camera component's own projection matrix is not usable here: the engine refreshes
    // it lazily only while it syncs the render view for a frame, which our custom pass
    // pipeline does after onPreRender runs - reading it there returns zeros. Build the
    // matrix ourselves the way the engine does, including its horizontalFov and orthographic
    // cases (see src/splat/gpu-projection.ts).
    buildGpuProjection(projMat, cam as any);
    viewProjMat.mul2(projMat, cam.viewMatrix);

    cameraParams4[0] = 1 / far; cameraParams4[1] = far; cameraParams4[2] = near; cameraParams4[3] = isOrtho ? 1 : 0;
    viewport4[0] = width; viewport4[1] = height; viewport4[2] = 1 / width; viewport4[3] = 1 / height;

    // M2-3：调用方带缓存时逐项比较，相机没动就一个 setParameter 都不发
    // （PiP 预览的"写入-恢复"对不带缓存，维持原行为）。
    if (cache) {
        cache.setArray(material, 'uSplatView', cam.viewMatrix.data);
        cache.setArray(material, 'uSplatViewProj', viewProjMat.data);
        cache.setArray(material, 'uSplatProj', projMat.data);
        cache.setArray(material, 'uSplatCameraParams', cameraParams4);
        cache.setArray(material, 'uSplatViewport', viewport4);
        return;
    }
    material.setParameter('uSplatView', cam.viewMatrix.data);
    material.setParameter('uSplatViewProj', viewProjMat.data);
    material.setParameter('uSplatProj', projMat.data);
    material.setParameter('uSplatCameraParams', cameraParams4);
    material.setParameter('uSplatViewport', viewport4);
};

export { writeGpuCameraUniforms };
export type { GpuCameraSource };
