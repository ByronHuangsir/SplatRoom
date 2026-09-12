// Batch conversion E2E: format factory multi-select UI + batchConvert + ZIP integrity
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- minimal zip reader (parse EOCD + central directory names) ----
function parseZip(buf) {
    const u8 = new Uint8Array(buf);
    // find EOCD (PK\x05\x06) scanning from end
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0; i--) {
        if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return { error: 'no EOCD' };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdStart = dv.getUint32(eocd + 16, true);
    // walk central directory
    const names = [];
    let p = cdStart;
    for (let i = 0; i < count; i++) {
        if (u8[p] !== 0x50 || u8[p + 1] !== 0x4b || u8[p + 2] !== 0x01 || u8[p + 3] !== 0x02) {
            return { error: `bad central header at ${p}`, count, names };
        }
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
        names.push(name);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { count, cdSize, cdStart, names, eocd };
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle',
               '--use-angle=swiftshader', '--enable-webgl', '--enable-webgl2', '--window-size=1440,900', '--hide-scrollbars']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errs.push('CONSOLE:' + m.text().slice(0, 200)); });

    await page.goto('http://localhost:3000/?mode=splatfactory', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__splatFactory, { timeout: 30000 }).catch(() => {});
    await sleep(400);

    // 1. UI: multi-select hints present
    const ui = await page.evaluate(() => {
        const title = document.querySelector('.sf-title')?.textContent;
        const h3 = Array.from(document.querySelectorAll('.sf-card h3')).map(h => h.textContent);
        const dropText = document.querySelector('.sf-drop')?.textContent?.replace(/\s+/g, ' ')?.trim();
        const input = document.querySelector('input[type=file]');
        return {
            title,
            h3,
            dropMulti: dropText?.includes('多选'),
            inputMultiple: input?.multiple,
            hasClearBtn: !!Array.from(document.querySelectorAll('.sf-btn')).find(b => b.textContent.includes('清空'))
        };
    });

    // 2. simulate multi-select via DataTransfer → change event → list renders
    const listUi = await page.evaluate(async () => {
        const mk = async (name) => {
            const res = await fetch('/' + name);
            return new File([await res.arrayBuffer()], name, { type: 'application/octet-stream' });
        };
        const [a, b] = await Promise.all([mk('test-batch-a.ply'), mk('test-batch-b.ply')]);
        const dt = new DataTransfer();
        dt.items.add(a);
        dt.items.add(b);
        const input = document.querySelector('input[type=file]');
        Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const rows = Array.from(document.querySelectorAll('.sf-row-item')).map(r => ({
            name: r.querySelector('.sf-row-name')?.textContent,
            badge: r.querySelector('.sf-badge')?.textContent
        }));
        const info = document.querySelector('.sf-file')?.textContent;
        const btnText = Array.from(document.querySelectorAll('.sf-btn')).find(b => b.textContent.includes('批量转换'))?.textContent;
        return { rows, info, btnText };
    });

    // 3. batchConvert via hook → verify ZIP structure in Node
    const batch = await page.evaluate(async () => {
        const mk = async (name) => {
            const res = await fetch('/' + name);
            return new File([await res.arrayBuffer()], name, { type: 'application/octet-stream' });
        };
        const files = await Promise.all([mk('test-batch-a.ply'), mk('test-batch-b.ply')]);
        const sf = window.__splatFactory;
        const r = await sf.batchConvert(files, 'splat');
        // encode Uint8Array → base64 (no Buffer in page context)
        let bin = '';
        for (let i = 0; i < r.zip.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, r.zip.subarray(i, i + 0x8000));
        }
        return { total: r.total, ok: r.ok, failed: r.failed, errors: r.errors, zipBytes: r.zipBytes, zipB64: btoa(bin) };
    });
    const zipBuf = Buffer.from(batch.zipB64, 'base64');
    const zipInfo = parseZip(zipBuf);
    delete batch.zipB64;

    // 4. mixed batch: one valid PLY + one invalid file → fail-safe behavior
    const mixed = await page.evaluate(async () => {
        const mk = async (name) => {
            const res = await fetch('/' + name);
            return new File([await res.arrayBuffer()], name, { type: 'application/octet-stream' });
        };
        const [a] = await Promise.all([mk('test-batch-a.ply')]);
        const bad = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'garbage.bin', { type: 'application/octet-stream' });
        const sf = window.__splatFactory;
        const r = await sf.batchConvert([a, bad], 'splat');
        return { total: r.total, ok: r.ok, failed: r.failed, errors: r.errors.map(e => e.slice(0, 80)) };
    });

    console.log(JSON.stringify({ ui, listUi, batch: { ...batch, zipNames: zipInfo.names, zipCount: zipInfo.count }, zipError: zipInfo.error, mixed, errs }, null, 2));
    await page.screenshot({ path: 'C:/Users/Byon Huang/WorkBuddy/SplatRoom/scripts/sf-batch-ui.png' });
    await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
