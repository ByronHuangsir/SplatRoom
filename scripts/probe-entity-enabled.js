// Probe entity.enabled 是否真的关闭 gsplat 渲染
const puppeteer = require('puppeteer-core');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'http://localhost:3000/seg-lab/?model=scene.ply';
const OUT = 'C:\\Users\\Byon Huang\\WorkBuddy\\SplatRoom\\scripts';

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: [
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
            '--no-sandbox', '--disable-dev-shm-usage',
            '--window-size=1280,720'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const consoleLines = [];
    page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));

    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('stat')?.textContent.includes('已加载'), { timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));

    // expose scene探针
    await page.evaluate(() => {
        const app = window.pc?.app || window.app;
        // 找到 entity list
        const list = [];
        if (window.splatEntity) list.push({ name: 'splatEntity', enabled: window.splatEntity.enabled, hasG: !!window.splatEntity.gsplat });
        if (window.selEntity) list.push({ name: 'selEntity', enabled: window.selEntity.enabled, hasG: !!window.selEntity.gsplat });
        if (window.bgEntity) list.push({ name: 'bgEntity', enabled: window.bgEntity.enabled, hasG: !!window.bgEntity.gsplat });
        window.__probeEntities = list;

        // 尝试遍历 app.root 找所有 entity
        const allList = [];
        if (window.app && window.app.root) {
            function walk(e, depth) {
                if (depth > 5) return;
                const hasG = !!e.gsplat;
                allList.push({ depth, name: e.name, enabled: e.enabled, hasGsplat: hasG, instance: hasG ? !!e.gsplat.instance : false });
                for (const c of e.children) walk(c, depth + 1);
            }
            walk(window.app.root, 0);
        }
        window.__allEntities = allList;
    });

    // box 选大球右部(模拟用户)
    await page.click('button[data-mode="box"]');
    await new Promise(r => setTimeout(r, 200));
    await page.mouse.move(880, 410);
    await page.mouse.down();
    await page.mouse.move(900, 420, { steps: 5 });
    await page.mouse.move(1020, 510, { steps: 10 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1500));

    const probeAfter = await page.evaluate(() => {
        return {
            allEntities: window.__allEntities,
            stat: document.getElementById('stat').textContent
        };
    });
    console.log('=== entities after box ===');
    console.log(JSON.stringify(probeAfter.allEntities, null, 2));
    console.log('=== stat ===', probeAfter.stat);

    await page.screenshot({ path: path.join(OUT, 'probe-1-afterbox.png') });

    // toggle high light
    await page.click('#btnHighlight');
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(OUT, 'probe-2-highlight.png') });
    const probeH = await page.evaluate(() => ({
        stat: document.getElementById('stat').textContent,
        entities: window.__allEntities
    }));
    console.log('=== after highlight ===', probeH.stat);

    await browser.close();
})();
