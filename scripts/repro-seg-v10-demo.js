// 复现用户操作: 切到"框选区域" → 拖框选红球区域 → 验证视觉
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

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
    page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
    // 等加载
    await page.waitForFunction(() => {
        const s = document.getElementById('stat');
        return s && s.textContent.includes('高斯已加载');
    }, { timeout: 30000 });
    await new Promise(r => setTimeout(r, 800));

    // 1) 切到"框选区域"
    await page.click('button[data-mode="box"]');
    await new Promise(r => setTimeout(r, 200));

    // 2) 截图 initial
    await page.screenshot({ path: path.join(OUT, 'demo-1-initial.png') });

    // 3) 找红球的屏幕坐标: 根据 gen-scene-ply.py 红球在 (1.35, 0.25, 1.15) 半径 0.25
    //    用 worldToScreen 探针
    const screenPos = await page.evaluate(() => {
        // 找到第一个红球附近高斯: 红球(1.35, 0.25, 1.15) R=0.25
        // 取世界坐标 (1.35, 0.25, 1.15) 通过当前相机 transform
        const cam = window.splatEntity || (window.__app && window.__app.camera);
        if (!cam) {
            // 尝试全局找
            const allKeys = Object.keys(window);
            return { error: 'no cam', keys: allKeys.filter(k => k.toLowerCase().includes('cam') || k.toLowerCase().includes('splat') || k.toLowerCase().includes('app')) };
        }
        return { ok: true };
    });
    console.log('screenPos probe:', screenPos);

    // 4) 模拟用户框选(画在画面的右下方红球位置)
    //    红球在场景右下方, 大概屏幕坐标 (920, 460) - (1000, 540)
    // 5) 直接从 mousedown 到 mouseup 模拟框选
    const box = { x0: 880, y0: 410, x1: 1020, y1: 510 };
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move(box.x0 + 20, box.y0 + 20, { steps: 5 });
    await page.mouse.move(box.x1, box.y1, { steps: 10 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1500));

    // 6) 截图 after box
    await page.screenshot({ path: path.join(OUT, 'demo-2-afterbox.png') });
    const stat2 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('after box stat:', stat2);

    // 7) 点击"高亮选中"按钮
    await page.click('#btnHighlight');
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(OUT, 'demo-3-highlight.png') });
    const stat3 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('after highlight stat:', stat3);

    // 8) 再点"隐藏背景"按钮
    await page.click('#btnHideBg');
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: path.join(OUT, 'demo-4-hidebg.png') });
    const stat4 = await page.evaluate(() => document.getElementById('stat').textContent);
    console.log('after hideBg stat:', stat4);

    // 输出场景对象状态
    const debug = await page.evaluate(() => {
        return {
            hasSplatEntity: !!window.splatEntity,
            hasSelEntity: !!window.selEntity,
            hasBgEntity: !!window.bgEntity,
            splatEnabled: window.splatEntity && window.splatEntity.enabled,
            selEnabled: window.splatEntity && window.selEntity && window.selEntity.enabled,
            bgEnabled: window.splatEntity && window.bgEntity && window.bgEntity.enabled
        };
    });
    console.log('debug:', debug);

    console.log('--- console ---');
    consoleLines.slice(-30).forEach(l => console.log(l));

    await browser.close();
})();
