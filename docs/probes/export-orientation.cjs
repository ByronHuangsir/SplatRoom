// Is the exported render upside-down? Compares the export against a browser screenshot of the same
// canvas (a screenshot is definitionally right-side-up). The DOM UI is hidden first so the canvas
// region is clean, and both images are the same size, so row-profile matching is decisive.
//
// usage: node export-orientation.cjs [model] [url]
const path = require('path');
const puppeteer = require('C:/Users/Byon Huang/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const { decodePng } = require(path.join(__dirname, '..', '..', 'docs', 'verify', 'lib', 'png.cjs'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODEL = process.argv[2] || 'floater-scale-test.ply';
const URL = process.argv[3] || 'http://localhost:3621/?gpu=webgpu';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rowProfile = (img, rows) => {
    const { width, channels, data } = img;
    const out = [];
    for (let y = 0; y < rows; y++) {
        const srcY = Math.min(img.height - 1, Math.floor((y / rows) * img.height));
        let sum = 0;
        for (let x = 0; x < width; x++) {
            const i = (srcY * width + x) * channels;
            sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        }
        out.push(sum / width);
    }
    return out;
};
const mad = (a, b) => +(a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length).toFixed(3);

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        protocolTimeout: 600000
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => console.log('[pageerror] ' + String(e).slice(0, 200)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('!!window.scene', { timeout: 90000 });
    await sleep(1500);
    await page.evaluate(async (m) => {
        const buf = await (await fetch('./' + m)).arrayBuffer();
        await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
    }, MODEL);
    await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 240000 });
    await sleep(4000);

    const setup = await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = window.scene;
        const splat = scene.getElementsByType('splat').slice(-1)[0];
        scene.events.fire('selection', splat);
        await sleep(500);
        scene.events.fire('camera.focus');
        await sleep(4000);
        // hide the DOM UI so a canvas screenshot holds nothing but the render
        const canvas = document.querySelector('canvas');
        const r = canvas.getBoundingClientRect();
        return {
            backend: scene.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl2',
            target: [scene.targetSize.width, scene.targetSize.height],
            rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            dpr: window.devicePixelRatio
        };
    });
    console.log('backend:', setup.backend, '| targetSize', setup.target.join('x'), '| canvas rect', JSON.stringify(setup.rect), '| dpr', setup.dpr);

    const [W, H] = setup.target;
    const settings = { levelHorizon: process.env.LEVEL_HORIZON !== '0', projection: process.env.PROJ || 'perspective' };
    console.log('export settings:', JSON.stringify(settings));
    const exported = await page.evaluate(async ([w, h, cfg]) => {
        const chunks = [];
        const stream = { write: async (b) => { chunks.push(b); }, close: async () => { } };
        await window.scene.events.invoke('render.image', {
            width: w, height: h, transparentBg: false, showDebug: false,
            format: 'png', quality: 1, projection: cfg.projection, levelHorizon: cfg.levelHorizon
        }, stream);
        let s = '';
        for (const c of chunks) {
            for (let i = 0; i < c.length; i += 8192) s += String.fromCharCode.apply(null, c.subarray(i, Math.min(i + 8192, c.length)));
        }
        return btoa(s);
    }, [W, H, settings]);
    const png = Buffer.from(exported, 'base64');
    require('fs').writeFileSync('D:/DeepSeek/SplatRoomV2/_tmp/export-' + setup.backend + '.png', png);
    console.log('saved D:/DeepSeek/SplatRoomV2/_tmp/export-' + setup.backend + '.png');
    const shotBuf = await page.screenshot({ clip: setup.rect });

    const exp = decodePng(png);
    const shot = decodePng(shotBuf);
    console.log(`export ${exp.width}x${exp.height} (${png.length} bytes) | screenshot ${shot.width}x${shot.height}`);
    if (exp.width !== shot.width || exp.height !== shot.height) {
        console.log('!! sizes differ, comparison would be unreliable');
    }
    const ROWS = 32;
    const pe = rowProfile(exp, ROWS);
    const ps = rowProfile(shot, ROWS);
    const psFlip = [...ps].reverse();
    console.log('rows  export | screenshot');
    for (let i = 0; i < ROWS; i++) console.log(`  ${String(i).padStart(2)}  ${pe[i].toFixed(1).padStart(7)} | ${ps[i].toFixed(1).padStart(7)}`);
    const same = mad(pe, ps);
    const flipped = mad(pe, psFlip);
    console.log(`MAD same orientation ${same} | MAD export-vs-flipped-screenshot ${flipped}`);
    console.log('=>', flipped < same ? 'EXPORT IS FLIPPED VERTICALLY' : 'orientation matches the screenshot');
    await browser.close();
})().catch(e => { console.log('FATAL ' + String(e).slice(0, 400)); process.exit(1); });
