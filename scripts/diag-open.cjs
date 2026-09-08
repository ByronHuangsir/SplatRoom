const puppeteer = require('puppeteer-core');
(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    let nErr = 0, firstErr = '', nWarn = 0;
    page.on('console', m => { 
        if (m.type() === 'error') { nErr++; if (!firstErr) firstErr = m.text().slice(0, 300); }
        if (m.type() === 'warn') nWarn++;
    });
    page.on('pageerror', e => { nErr++; if (!firstErr) firstErr = String(e).slice(0, 300); });
    
    console.log('goto...');
    await page.goto('http://localhost:3000/?mode=merge', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));
    
    const diag = await page.evaluate(function() {
        var body = (document.body && document.body.innerText || 'no body').slice(0, 500);
        var app = !!window.__mergeApp;
        var models = -1;
        if (app) models = (window.__mergeApp.scene && window.__mergeApp.scene.models ? window.__mergeApp.scene.models.length : 0);
        var panel = !!document.querySelector('.merge-panel');
        var canvas = !!document.querySelector('canvas');
        return { app: app, models: models, hasPanel: panel, hasCanvas: canvas, bodySnippet: body.slice(0, 200) };
    }).catch(function(e) { return 'EVAL-ERR: ' + e.message; });
    
    console.log('DIAG:', JSON.stringify(diag));
    console.log('errors:', nErr, 'warns:', nWarn, 'first:', firstErr);
    await browser.close();
})().catch(function(e) { console.error('FATAL:', e.message.slice(0, 300)); process.exit(1); });
