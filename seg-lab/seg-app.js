// SplatRoom · 物体分割实验台（算法原型 · 方案B: SAM 2D→3D 投影）
// 思路：用户给出 2D 提示（点 / 框）→ 把全部高斯投影到屏幕空间 →
//   用「逐像素最小深度带」保留「提示区域内的高斯 + 其前方（含共面）高斯」，
//   剔除落在同一屏幕像素、但位于物体背后的背景高斯。
// 渲染：PlayCanvas GSplat；输出：隐藏背景 / 导出子模型

const SH_C0 = 0.28209479177387814;

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
const stat = (s) => { $('stat').textContent = s; };

// ---------- render state ----------
let app, device, cameraEntity, splatEntity, asset = null;
let currentAsset = null;    // tracked so we can unload on reload
let engineReady = false;
let modelMeta = { name: '', sizeKB: 0 };
let data = null;            // GSplatData
let N = 0;
let px, py, pz;             // positions
let dc0, dc1, dc2;          // f_dc (SH C0 encoded)
let op;                     // opacity (logit)
let s0, s1, s2;             // scale (log)
let r0, r1, r2, r3;         // rotation (wxyz)
let rgbCache = null;        // Float32Array(N*3) decoded rgb 0..1
let origDC0, origDC1, origDC2, origOp, origS0, origS1, origS2;

// ---------- selection / segmentation state ----------
let mode = 'click';         // 'click' | 'box' | 'orbit'
let mask = null;            // Uint8Array(N) 1 = selected
let highlightOn = false;
let hideBgOn = false;

// 2D prompt in CSS-pixel (relative to canvas)
//   {kind:'click', cx, cy, r}  |  {kind:'box', x0,y0,x1,y1}
let prompt2D = null;

// ---------- camera orbit ----------
const camState = { target: [0, 0, 0], yaw: -30, pitch: -20, dist: 2.6 };
let dragging = null;        // {type:'orbit'|'pan', lastX, lastY}

// ---------- subset render (reliable in PlayCanvas unified gsplat) ----------
let selEntity = null, bgEntity = null;
let lastToggle = -1;

// =====================================================================
//  engine bootstrap (once), then model loading onto it
// =====================================================================
async function bootEngine() {
    const canvas = $('app');
    device = await pc.createGraphicsDevice(canvas, {
        deviceTypes: ['webgl2'], antialias: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
    });
    app = new pc.Application(canvas, { graphicsDevice: device });
    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    app.start();

    cameraEntity = new pc.Entity('camera');
    cameraEntity.addComponent('camera', {
        clearColor: new pc.Color(0.13, 0.13, 0.16, 1),
        nearClip: 0.01, farClip: 200
    });
    app.root.addChild(cameraEntity);
    app.scene.gammaCorrection = pc.GAMMA_SRGB;
    app.scene.toneMapping = pc.TONEMAP_ACES;
    updateCamera();

    window.addEventListener('resize', () => {
        app.resizeCanvas();
        updateCamera();
    });
    engineReady = true;
}

// unwrap and destroy the previous model + its sub-split entities
function teardownModel() {
    if (selEntity) { selEntity.destroy(); selEntity = null; }
    if (bgEntity)  { bgEntity.destroy();  bgEntity = null; }
    if (splatEntity) { splatEntity.destroy(); splatEntity = null; }
    if (currentAsset) { app.assets.remove(currentAsset); currentAsset = null; }
    lastToggle = -1;
    mask = null; prompt2D = null; hideBgOn = false; highlightOn = false;
}

async function loadModelFromBuffer(buf, name, sizeKB) {
    if (!engineReady) await bootEngine();
    teardownModel();
    stat('解析中… ' + (name || ''));
    // yield so the "解析中" text paints before the (synchronous) parse
    await new Promise(r => requestAnimationFrame(() => r()));

    const parsed = parseFloatPly(buf);
    if (!parsed) {
        stat('解析失败：仅支持 binary_little_endian 的 float PLY（3DGS）。请确认是高斯模型 .ply');
        return;
    }
    const gsplatData = new pc.GSplatData([{ name: 'vertex', count: parsed.numSplats, properties: parsed.props }]);
    const resource = new pc.GSplatResource(device, gsplatData, { prepareCenters: true });
    const a = new pc.Asset('model', 'gsplat', { url: 'manual-' + Date.now() });
    a.resource = resource;
    a.loaded = true; a.loading = false;
    app.assets.add(a);
    currentAsset = a;

    if (!a.resource) { stat('模型加载失败: ' + name); return; }
    splatEntity = new pc.Entity('splat');
    splatEntity.addComponent('gsplat', { asset: a });
    app.root.addChild(splatEntity);
    data = a.resource.gsplatData;
    modelMeta = { name: name || '', sizeKB: sizeKB || 0 };
    onDataReady();
}

async function init() {
    console.log('[seg-app] boot');
    await bootEngine();
    const urlParams = new URLSearchParams(location.search);
    const modelUrl = urlParams.get('model') || 'scene.ply';
    await loadModelFromURL(modelUrl);
}

async function loadModelFromURL(modelUrl) {
    stat('下载模型… ' + modelUrl);
    try {
        const resp = await fetch(modelUrl);
        if (!resp.ok) { stat('模型加载失败: HTTP ' + resp.status + '（' + modelUrl + '）'); return; }
        const buf = new Uint8Array(await resp.arrayBuffer());
        const sizeKB = Math.round(buf.length / 1024);
        const name = modelUrl.split('/').pop();
        await loadModelFromBuffer(buf, name, sizeKB);
        if (document.getElementById('fileUrl')) document.getElementById('fileUrl').value = modelUrl;
    } catch (err) {
        stat('下载失败（跨域/CORS 或服务不可达）：' + (err && err.message) + ' — 建议改用「选择文件」或拖拽本地 .ply');
    }
}

function onDataReady() {
    try {
        N = data.numSplats;
        px = data.getProp('x'); py = data.getProp('y'); pz = data.getProp('z');
        dc0 = data.getProp('f_dc_0'); dc1 = data.getProp('f_dc_1'); dc2 = data.getProp('f_dc_2');
        op = data.getProp('opacity');
        s0 = data.getProp('scale_0'); s1 = data.getProp('scale_1'); s2 = data.getProp('scale_2');
        r0 = data.getProp('rot_0'); r1 = data.getProp('rot_1'); r2 = data.getProp('rot_2'); r3 = data.getProp('rot_3');

        origDC0 = new Float32Array(dc0); origDC1 = new Float32Array(dc1); origDC2 = new Float32Array(dc2);
        origOp = new Float32Array(op);
        origS0 = new Float32Array(s0); origS1 = new Float32Array(s1); origS2 = new Float32Array(s2);

        rgbCache = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            rgbCache[i*3]   = Math.max(0, Math.min(1, dc0[i] * SH_C0 + 0.5));
            rgbCache[i*3+1] = Math.max(0, Math.min(1, dc1[i] * SH_C0 + 0.5));
            rgbCache[i*3+2] = Math.max(0, Math.min(1, dc2[i] * SH_C0 + 0.5));
        }

        mask = new Uint8Array(N);
        fitCamera();
        const meta = modelMeta.name ? ` · ${modelMeta.name}` : '';
        const sizeTxt = modelMeta.sizeKB ? ` · ${(modelMeta.sizeKB/1024/1024).toFixed(1)}MB` : '';
        stat(`${N.toLocaleString()} 高斯已加载${meta}${sizeTxt} — 在物体上「点一下」或「框选」试试`);
    } catch (err) {
        console.error('[seg-app] onDataReady error:', err && err.stack || err);
        stat('数据准备失败: ' + (err && err.message));
    }
}

// =====================================================================
//  manual float-PLY parser (INRIA 3DGS layout)
// =====================================================================
function parseFloatPly(buf) {
    let off = 0;
    const text = new TextDecoder('ascii');
    let headerLen = -1;
    let vertexCount = -1;
    let format = '';
    const properties = [];
    const str = text.decode(buf.subarray(0, Math.min(buf.length, 65536)));
    const lines = str.split('\n');
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li].trim();
        if (line.startsWith('format ')) format = line.split(/\s+/)[1];
        if (line.startsWith('element vertex ')) vertexCount = parseInt(line.split(/\s+/)[2], 10);
        if (line.startsWith('property ')) {
            const parts = line.split(/\s+/);
            properties.push({ type: parts[1], name: parts[2] });
        }
        if (line === 'end_header') {
            headerLen = str.indexOf('end_header') + 'end_header'.length + 1;
            break;
        }
    }
    if (headerLen < 0 || vertexCount < 0) return null;
    if (format !== 'binary_little_endian') return null;

    const props = [];
    let cursor = headerLen;
    const typeSize = { 'float': 4, 'float32': 4, 'uchar': 1, 'uint8': 1 };
    const stride = properties.reduce((acc, p) => acc + (typeSize[p.type] || 0), 0);
    let propOffset = 0;
    for (const p of properties) {
        const size = typeSize[p.type];
        if (!size) continue;
        const Ctor = size === 1 ? Uint8Array : Float32Array;
        const arr = new Ctor(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            const view = new DataView(buf.buffer, buf.byteOffset + headerLen + i * stride + propOffset, size);
            arr[i] = size === 1 ? view.getUint8(0) : view.getFloat32(0, true);
        }
        propOffset += size;
        props.push({ type: p.type === 'float' ? 'float' : 'uint8', name: p.name, storage: arr, byteSize: size });
    }
    return { numSplats: vertexCount, props };
}

// =====================================================================
//  SAM 2D→3D projection segmentation
// =====================================================================
function runSegmentation() {
    if (!mask || !prompt2D) { stat('请先在物体上点一下，或拖框选择'); return; }
    const t0 = performance.now();

    // ---- 1. project all gaussians to the current camera's screen space ----
    // Build view+projection matrices from scratch. Cached matrices on
    // pc.Camera (projectionMatrix/viewMatrix) can disagree with the gsplat
    // renderer, and pc.Mat4.transformPoint's perspective-divide semantics
    // differ between PlayCanvas builds. So we compute everything explicitly
    // (gluLookAt-style) so the math is independent of those caches.
    const camComp = cameraEntity.camera;
    const pos = cameraEntity.getPosition();
    const t = camState.target;
    let fx = t[0] - pos.x, fy = t[1] - pos.y, fz = t[2] - pos.z;
    let fl = Math.hypot(fx, fy, fz); if (fl > 0) { fx/=fl; fy/=fl; fz/=fl; }
    // s = right = normalize(cross(f, worldUp)); u = up = cross(s, f)
    // cross(f, up) = (fy*1 - fz*0, fz*0 - fx*1, fx*0 - fy*0) = (fy, 0, -fx)
    let sx_ = -fz, sy_ = 0, sz_ = fx;
    const sl = Math.hypot(sx_, sy_, sz_) || 1; sx_/=sl; sy_/=sl; sz_/=sl;
    const ux_ = fy*sz_ - fz*sy_, uy_ = fz*sx_ - fx*sz_, uz_ = fx*sy_ - fy*sx_;
    // view (column-major data): rows are [s; u; -f; -dot(.,pos) with +dot(f,pos)]
    const view = new pc.Mat4().set([
        sx_, sy_, sz_, 0,
        ux_, uy_, uz_, 0,
        -fx, -fy, -fz, 0,
        -(sx_*pos.x + sy_*pos.y + sz_*pos.z),
        -(ux_*pos.x + uy_*pos.y + uz_*pos.z),
        (fx*pos.x + fy*pos.y + fz*pos.z),
        1
    ]);
    const fovY = camComp.fov * Math.PI / 180;
    const aspect = device.width / device.height;
    const near = camComp.nearClip, far = camComp.farClip;
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const proj = new pc.Mat4().set([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0
    ]);
    const vp = new pc.Mat4().mul2(proj, view);
    const m = vp.data;

    const rect = device.canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;

    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const depth = new Float32Array(N);     // camera-space linear depth (positive in front)
    const behind = new Uint8Array(N);
    const cv = new pc.Vec3();
    let minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < N; i++) {
        const x = px[i], y = py[i], z = pz[i];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw <= 1e-6) { behind[i] = 1; sx[i] = sy[i] = -1; continue; }
        const cx = m[0] * x + m[4] * y + m[8]  * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9]  * z + m[13];
        const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
        const ndcx = cx / cw, ndcy = cy / cw, ndcz = cz / cw;
        if (ndcz > 1 || ndcz < -1 || cw <= 0) { behind[i] = 1; sx[i] = sy[i] = -1; continue; }
        const X = (ndcx * 0.5 + 0.5) * W;
        const Y = (1 - (ndcy * 0.5 + 0.5)) * H;
        sx[i] = X; sy[i] = Y;
        // camera-space depth (positive in front). Compute from view matrix
        // manually to avoid transformPoint's perspective divide semantics.
        const vM = view.data;
        const cz_cam = vM[2]*x + vM[6]*y + vM[10]*z + vM[14];
        const d = -cz_cam;
        depth[i] = d;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
    }
    const sceneRange = (maxD - minD) || 1;

    // ---- 2. inside-prompt test ----
    const inside = (i) => {
        const x = sx[i], y = sy[i];
        if (behind[i] || x < 0 || x >= W || y < 0 || y >= H) return false;
        if (prompt2D.kind === 'click') {
            const dx = x - prompt2D.cx, dy = y - prompt2D.cy;
            return dx*dx + dy*dy <= prompt2D.r * prompt2D.r;
        }
        return x >= prompt2D.x0 && x <= prompt2D.x1 && y >= prompt2D.y0 && y <= prompt2D.y1;
    };

    // ---- 3. per-screen-pixel minimum depth of an "inside" splat ----
    const step = 2;                         // grid resolution (px)
    const gw = Math.max(1, Math.ceil(W / step));
    const gh = Math.max(1, Math.ceil(H / step));
    const depthMap = new Float32Array(gw * gh).fill(Infinity);
    let inCount = 0, dMinIn = Infinity, dMaxIn = -Infinity;
    for (let i = 0; i < N; i++) {
        if (!inside(i)) continue;
        inCount++;
        const gx = Math.min(gw - 1, Math.max(0, (sx[i] / step) | 0));
        const gy = Math.min(gh - 1, Math.max(0, (sy[i] / step) | 0));
        const cell = gy * gw + gx;
        if (depth[i] < depthMap[cell]) depthMap[cell] = depth[i];
        if (depth[i] < dMinIn) dMinIn = depth[i];
        if (depth[i] > dMaxIn) dMaxIn = depth[i];
    }
    if (inCount === 0) {
        stat('提示区域未命中任何高斯 — 请对准物体表面再点 / 框');
        return;
    }

    // ---- 4. depth band: keep inside splats + anything in front + a thin
    //         margin behind (to drop background sitting further back) ----
    const tolFrac = Number($('depthTol').value) / 100;   // e.g. 3% of scene range
    const band = (dMaxIn - dMinIn) + sceneRange * tolFrac;

    mask.fill(0);
    let count = 0;
    for (let i = 0; i < N; i++) {
        if (behind[i]) continue;
        const x = sx[i], y = sy[i];
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const gx = Math.min(gw - 1, Math.max(0, (x / step) | 0));
        const gy = Math.min(gh - 1, Math.max(0, (y / step) | 0));
        const cell = gy * gw + gx;
        const dmin = depthMap[cell];
        if (dmin === Infinity) continue;            // no inside splat in this pixel → background to the side
        if (depth[i] <= dmin + band) { mask[i] = 1; count++; }
    }

    const ms = (performance.now() - t0).toFixed(1);
    let sxMin=Infinity,sxMax=-Infinity,syMin=Infinity,syMax=-Infinity,bhCount=0;
    for (let i=0;i<N;i++){ if(behind[i])bhCount++; if(sx[i]<sxMin)sxMin=sx[i]; if(sx[i]>sxMax)sxMax=sx[i]; if(sy[i]<syMin)syMin=sy[i]; if(sy[i]>syMax)syMax=sy[i]; }
    console.log('[seg-debug] W,H=',W.toFixed(0),',',H.toFixed(0),'sx[',sxMin.toFixed(0),sxMax.toFixed(0),'] sy[',syMin.toFixed(0),syMax.toFixed(0),'] behind=',bhCount,'inCount=', inCount, 'dMinIn=', dMinIn.toFixed(3), 'dMaxIn=', dMaxIn.toFixed(3), 'sceneRange=', sceneRange.toFixed(3), 'band=', band.toFixed(3), 'count=', count);
    if (count >= N) {
        stat(`⚠ 选中了全部 ${N.toLocaleString()}（${ms}ms）— 提示可能覆盖了整个画面，请缩小框 / 调小点击半径`);
        hideBgOn = false;
        applyVisual();
        return;
    }
    stat(`分割完成：选中 ${count.toLocaleString()} / ${N.toLocaleString()}（${ms}ms）`);
    hideBgOn = true;
    applyVisual();
}

// =====================================================================
//  visuals: hide background / reset  (subset-entity split — reliable)
// =====================================================================
function applyVisual() {
    if (!asset || !asset.resource) return;
    const r = asset.resource;
    if (!r.streams) return;

    const selIdx = [];
    const bgIdx = [];
    for (let i = 0; i < N; i++) {
        if (mask[i]) selIdx.push(i);
        else bgIdx.push(i);
    }

    rebuildSubsets(selIdx, bgIdx);
    const showSel = !!(hideBgOn || highlightOn);
    const showBg  = !hideBgOn;
    if (selEntity) selEntity.enabled = showSel;
    if (bgEntity)  bgEntity.enabled = showBg;

    const counted = selIdx.length;
    stat(hideBgOn
        ? `隐藏背景（${counted.toLocaleString()} 高斯保留）`
        : highlightOn
            ? `保留选中（${counted.toLocaleString()}）其余隐藏`
            : '全部显示（拆分渲染）');
}

function rebuildSubsets(selIdx, bgIdx) {
    const sig = selIdx.length + ':' + bgIdx.length;
    if (sig === lastToggle && (selEntity || bgEntity)) return;
    lastToggle = sig;

    function buildSubData(idxs) {
        if (!idxs.length) return null;
        const props = [];
        const defs = [
            ['x','float'],['y','float'],['z','float'],
            ['f_dc_0','float'],['f_dc_1','float'],['f_dc_2','float'],
            ['opacity','float'],
            ['scale_0','float'],['scale_1','float'],['scale_2','float'],
            ['rot_0','float'],['rot_1','float'],['rot_2','float'],['rot_3','float']
        ];
        for (const [name, type] of defs) {
            const arr = new Float32Array(idxs.length);
            for (let k = 0; k < idxs.length; k++) {
                const i = idxs[k];
                if      (name === 'x')           arr[k] = px[i];
                else if (name === 'y')           arr[k] = py[i];
                else if (name === 'z')           arr[k] = pz[i];
                else if (name === 'f_dc_0')      arr[k] = dc0[i];
                else if (name === 'f_dc_1')      arr[k] = dc1[i];
                else if (name === 'f_dc_2')      arr[k] = dc2[i];
                else if (name === 'opacity')     arr[k] = op[i];
                else if (name === 'scale_0')     arr[k] = s0[i];
                else if (name === 'scale_1')     arr[k] = s1[i];
                else if (name === 'scale_2')     arr[k] = s2[i];
                else if (name === 'rot_0')       arr[k] = r0[i];
                else if (name === 'rot_1')       arr[k] = r1[i];
                else if (name === 'rot_2')       arr[k] = r2[i];
                else if (name === 'rot_3')       arr[k] = r3[i];
            }
            props.push({ type, name, storage: arr, byteSize: 4 });
        }
        return new pc.GSplatData([{ name: 'vertex', count: idxs.length, properties: props }]);
    }

    function bindSubEntity(subData, label) {
        if (!subData) return null;
        const r = new pc.GSplatResource(device, subData);
        const a = new pc.Asset('sub-' + label + '-' + Math.random(), 'gsplat');
        a.resource = r;
        a.loaded = true; a.loading = false;
        app.assets.add(a);
        const e = new pc.Entity('splat-' + label);
        e.addComponent('gsplat', { asset: a });
        app.root.addChild(e);
        return e;
    }

    if (selEntity) { selEntity.destroy(); selEntity = null; }
    if (bgEntity)  { bgEntity.destroy();  bgEntity = null; }

    selEntity = bindSubEntity(buildSubData(selIdx), 'sel');
    bgEntity  = bindSubEntity(buildSubData(bgIdx),  'bg');

    if (splatEntity) splatEntity.enabled = false;
}

function resetAll() {
    if (mask) mask.fill(0);
    highlightOn = false; hideBgOn = false;
    for (let i = 0; i < N; i++) {
        dc0[i] = origDC0[i]; dc1[i] = origDC1[i]; dc2[i] = origDC2[i];
        op[i]  = origOp[i];
        s0[i]  = origS0[i]; s1[i] = origS1[i]; s2[i] = origS2[i];
    }
    if (selEntity) { selEntity.destroy(); selEntity = null; }
    if (bgEntity)  { bgEntity.destroy();  bgEntity = null; }
    lastToggle = -1;
    if (splatEntity) splatEntity.enabled = true;
    prompt2D = null;
    hidePromptDisk();
    stat('已重置');
}

// =====================================================================
//  export sub-model (.ply, INRIA 3DGS format)
// =====================================================================
function exportSubModel() {
    if (!mask) return;
    const idx = [];
    for (let i = 0; i < N; i++) if (mask[i]) idx.push(i);
    if (!idx.length) { stat('没有选中高斯'); return; }
    const M = idx.length;
    const header = `ply\nformat binary_little_endian 1.0\ncomment exported sub-model from SplatRoom segmentation lab (SAM 2D->3D projection)\nelement vertex ${M}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n`;
    const buf = new ArrayBuffer(header.length + M * 68);
    const view = new DataView(buf);
    let off = 0;
    for (let c = 0; c < header.length; c++) view.setUint8(off++, header.charCodeAt(c));
    const tmp = new pc.Quat();
    for (let k = 0; k < M; k++) {
        const i = idx[k];
        view.setFloat32(off, px[i], true); off += 4;
        view.setFloat32(off, py[i], true); off += 4;
        view.setFloat32(off, pz[i], true); off += 4;
        tmp.set(r0[i], r1[i], r2[i], r3[i]).normalize();
        const m = tmp.getMatrix();
        view.setFloat32(off, m.data[8], true); off += 4;
        view.setFloat32(off, m.data[9], true); off += 4;
        view.setFloat32(off, m.data[10], true); off += 4;
        view.setFloat32(off, dc0[i], true); off += 4;
        view.setFloat32(off, dc1[i], true); off += 4;
        view.setFloat32(off, dc2[i], true); off += 4;
        view.setFloat32(off, op[i], true); off += 4;
        view.setFloat32(off, s0[i], true); off += 4;
        view.setFloat32(off, s1[i], true); off += 4;
        view.setFloat32(off, s2[i], true); off += 4;
        view.setFloat32(off, r0[i], true); off += 4;
        view.setFloat32(off, r1[i], true); off += 4;
        view.setFloat32(off, r2[i], true); off += 4;
        view.setFloat32(off, r3[i], true); off += 4;
    }
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'segment-' + M + '.ply';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    stat(`已导出 ${M.toLocaleString()} 高斯 → segment-${M}.ply`);
}

// =====================================================================
//  camera
// =====================================================================
function updateCamera() {
    const t = camState.target;
    const cy = camState.dist * Math.sin(camState.pitch * Math.PI / 180);
    const cr = camState.dist * Math.cos(camState.pitch * Math.PI / 180);
    const cx = t[0] + cr * Math.sin(camState.yaw * Math.PI / 180);
    const cz = t[2] + cr * Math.cos(camState.yaw * Math.PI / 180);
    cameraEntity.setPosition(cx, t[1] + cy, cz);
    cameraEntity.lookAt(t[0], t[1], t[2]);
}

function fitCamera() {
    // Compute AABB manually from the loaded positions instead of using
    // GSplatData.calcAabb — in this PlayCanvas build calcAabb returns a
    // wildly inflated box (halfExtents ~70 instead of ~3 for our test model),
    // which makes fitCamera park the camera 15x too far away and collapses
    // the whole model into a 40px blob on screen.
    let minX=Infinity, minY=Infinity, minZ=Infinity;
    let maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
    for (let i = 0; i < N; i++) {
        const x = px[i], y = py[i], z = pz[i];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2, hy = (maxY - minY) / 2, hz = (maxZ - minZ) / 2;
    const r = Math.hypot(hx, hy, hz) || 0.5;
    camState.target = [cx, cy, cz];
    camState.dist = r * 2.6;
    updateCamera();
}

// =====================================================================
//  prompt overlay
// =====================================================================
function showPromptDisk(cx, cy, r) {
    const d = $('promptDisk');
    d.style.display = 'block';
    d.style.left = (cx - r) + 'px';
    d.style.top = (cy - r) + 'px';
    d.style.width = (r * 2) + 'px';
    d.style.height = (r * 2) + 'px';
}
function hidePromptDisk() { $('promptDisk').style.display = 'none'; }

// =====================================================================
//  mouse interaction
// =====================================================================
let marqueeStart = null;

function onMouseDown(e) {
    if (e.button === 2) { dragging = { type: 'pan', lastX: e.clientX, lastY: e.clientY }; return; }
    if (mode === 'orbit') { dragging = { type: 'orbit', lastX: e.clientX, lastY: e.clientY }; return; }
    if (mode === 'box') {
        marqueeStart = [e.clientX, e.clientY];
        const mq = $('marquee');
        mq.style.display = 'block';
        mq.style.left = e.clientX + 'px';
        mq.style.top = e.clientY + 'px';
        mq.style.width = '0px';
        mq.style.height = '0px';
        return;
    }
    // click / seed
    const rect = device.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const r = Number($('clickR').value);
    prompt2D = { kind: 'click', cx, cy, r };
    showPromptDisk(cx, cy, r);
    runSegmentation();
}

function onMouseMove(e) {
    if (dragging) {
        const dx = e.clientX - dragging.lastX;
        const dy = e.clientY - dragging.lastY;
        dragging.lastX = e.clientX; dragging.lastY = e.clientY;
        if (dragging.type === 'orbit') {
            camState.yaw += dx * 0.4;
            camState.pitch = Math.max(-85, Math.min(85, camState.pitch + dy * 0.4));
            updateCamera();
        } else {
            const s = camState.dist * 0.0012;
            const yaw = camState.yaw * Math.PI / 180;
            camState.target[0] += (-dx * Math.cos(yaw) - dy * Math.sin(yaw)) * s;
            camState.target[2] += (dx * Math.sin(yaw) - dy * Math.cos(yaw)) * s;
            camState.target[1] += dy * s;
            updateCamera();
        }
        return;
    }
    if (marqueeStart) {
        const mq = $('marquee');
        const x = Math.min(marqueeStart[0], e.clientX), y = Math.min(marqueeStart[1], e.clientY);
        mq.style.left = x + 'px';
        mq.style.top = y + 'px';
        mq.style.width = Math.abs(e.clientX - marqueeStart[0]) + 'px';
        mq.style.height = Math.abs(e.clientY - marqueeStart[1]) + 'px';
    }
}

function onMouseUp(e) {
    if (dragging) { dragging = null; return; }
    if (marqueeStart) {
        $('marquee').style.display = 'none';
        const x0 = marqueeStart[0], y0 = marqueeStart[1];
        marqueeStart = null;
        const rect = device.canvas.getBoundingClientRect();
        const px0 = Math.min(x0, e.clientX) - rect.left;
        const py0 = Math.min(y0, e.clientY) - rect.top;
        const px1 = Math.max(x0, e.clientX) - rect.left;
        const py1 = Math.max(y0, e.clientY) - rect.top;
        if (px1 - px0 < 3 && py1 - py0 < 3) { stat('框太小，请拖一个更大的框'); return; }
        prompt2D = { kind: 'box', x0: px0, y0: py0, x1: px1, y1: py1 };
        runSegmentation();
    }
}

function onWheel(e) {
    e.preventDefault();
    camState.dist *= Math.exp(e.deltaY * 0.0012);
    camState.dist = Math.max(0.05, Math.min(200, camState.dist));
    updateCamera();
}

function bindUI() {
    const canvas = $('app');
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    document.querySelectorAll('#modeBar button').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#modeBar button').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            mode = btn.dataset.mode;
            stat(`模式：${btn.textContent}`);
        });
    });

    $('btnRun').addEventListener('click', runSegmentation);
    $('btnHideBg').addEventListener('click', () => {
        if (!mask || !prompt2D) { stat('请先点选 / 框选一个物体，再隐藏背景'); return; }
        hideBgOn = !hideBgOn;
        applyVisual();
    });
    $('btnExport').addEventListener('click', exportSubModel);
    $('btnReset').addEventListener('click', resetAll);

    // ---- real-model loading ----
    const fileInput = $('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            stat('读取文件… ' + f.name);
            const buf = new Uint8Array(await f.arrayBuffer());
            await loadModelFromBuffer(buf, f.name, Math.round(f.size / 1024));
        });
    }
    const fileUrl = $('fileUrl');
    const btnLoadUrl = $('btnLoadUrl');
    if (btnLoadUrl && fileUrl) {
        const go = () => { const u = fileUrl.value.trim(); if (u) loadModelFromURL(u); };
        btnLoadUrl.addEventListener('click', go);
        fileUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }
    // drag & drop anywhere on the canvas
    const dropHint = $('dropHint');
    const showDrop = (on) => { if (dropHint) dropHint.style.display = on ? 'block' : 'none'; };
    window.addEventListener('dragover', (e) => { e.preventDefault(); showDrop(true); });
    window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) showDrop(false); });
    window.addEventListener('drop', async (e) => {
        e.preventDefault(); showDrop(false);
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        stat('读取文件… ' + f.name);
        const buf = new Uint8Array(await f.arrayBuffer());
        await loadModelFromBuffer(buf, f.name, Math.round(f.size / 1024));
    });
}

// entry
bindUI();
init().then(() => {}).catch((err) => stat('初始化失败: ' + err));

// ---- DEBUG: expose a projection probe so tests can find object screen coords
//       (保留为调试用；不影响功能。)
window.__segProbe = function (wx, wy, wz) {
    const rect = device.canvas.getBoundingClientRect();
    const camComp = cameraEntity.camera;
    const pos = cameraEntity.getPosition();
    const t = camState.target;
    let fx = t[0] - pos.x, fy = t[1] - pos.y, fz = t[2] - pos.z;
    const fl = Math.hypot(fx, fy, fz); fx/=fl; fy/=fl; fz/=fl;
    let sx_ = -fz, sy_ = 0, sz_ = fx;
    const sl = Math.hypot(sx_, sy_, sz_) || 1; sx_/=sl; sy_/=sl; sz_/=sl;
    const ux_ = fy*sz_ - fz*sy_, uy_ = fz*sx_ - fx*sz_, uz_ = fx*sy_ - fy*sx_;
    const m_view = [
        sx_, sy_, sz_, 0,
        ux_, uy_, uz_, 0,
        -fx, -fy, -fz, 0,
        -(sx_*pos.x + sy_*pos.y + sz_*pos.z),
        -(ux_*pos.x + uy_*pos.y + uz_*pos.z),
        (fx*pos.x + fy*pos.y + fz*pos.z),
        1
    ];
    const fovY = camComp.fov * Math.PI / 180;
    const aspect = device.width / device.height;
    const near = camComp.nearClip, far = camComp.farClip;
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const m_proj = [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0
    ];
    const Xv=wx, Yv=wy, Zv=wz, Wv=1;
    const vx = m_view[0]*Xv + m_view[4]*Yv + m_view[8]*Zv + m_view[12]*Wv;
    const vy = m_view[1]*Xv + m_view[5]*Yv + m_view[9]*Zv + m_view[13]*Wv;
    const vz = m_view[2]*Xv + m_view[6]*Yv + m_view[10]*Zv + m_view[14]*Wv;
    const vw = m_view[3]*Xv + m_view[7]*Yv + m_view[11]*Zv + m_view[15]*Wv;
    const cx = m_proj[0]*vx + m_proj[4]*vy + m_proj[8]*vz + m_proj[12]*vw;
    const cy = m_proj[1]*vx + m_proj[5]*vy + m_proj[9]*vz + m_proj[13]*vw;
    const cw = m_proj[3]*vx + m_proj[7]*vy + m_proj[11]*vz + m_proj[15]*vw;
    const X = ((cx / cw) * 0.5 + 0.5) * rect.width;
    const Y = (1 - (cy / cw) * 0.5 - 0.5) * rect.height;
    return { x: X, y: Y };
};
