var puppeteer = require('puppeteer-core');
(async function() {
    var browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    var page = await browser.newPage();
    var errs = [];
    page.on('console', function(m) { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', function(e) { errs.push(String(e).slice(0, 200)); });
    
    console.log('open local...');
    await page.goto('http://localhost:3000/?mode=merge', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(function(r) { setTimeout(r, 6000); });
    
    var r1 = await page.evaluate(function() {
        return {
            app: !!window.__mergeApp,
            bodyLen: document.body ? document.body.innerHTML.length : -1,
            canvas: !!document.querySelector('canvas'),
            panel: !!document.querySelector('.merge-panel'),
            text: document.body ? (document.body.innerText || '').slice(0, 300) : 'no body'
        };
    });
    console.log('LOCAL:', JSON.stringify(r1));
    console.log('LOCAL errs:', errs.length);
    
    errs = [];
    console.log('open deploy...');
    await page.goto('https://6d6ef45c39e94ed2bd0920bdf6a57a14.bj7.agentos-app.net/?mode=merge', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(function(r) { setTimeout(r, 6000); });
    
    var r2 = await page.evaluate(function() {
        return {
            app: !!window.__mergeApp,
            bodyLen: document.body ? document.body.innerHTML.length : -1,
            canvas: !!document.querySelector('canvas'),
            panel: !!document.querySelector('.merge-panel'),
            text: document.body ? (document.body.innerText || '').slice(0, 300) : 'no body'
        };
    });
    console.log('DEPLOY:', JSON.stringify(r2));
    console.log('DEPLOY errs:', errs.length);
    
    await browser.close();
})().catch(function(e) { console.error('FATAL:', e.message.slice(0, 300)); process.exit(1); });
