#!/usr/bin/env node
/**
 * L1 browser integration probe.
 *
 * Serves `dist/` over http, loads `lw-probe.html` in headless Edge
 * (SwiftShader WebGL), and reads `window.__PROBE_RESULT__` which asserts the
 * worker-backed `loadGSplatDataAsync` produces a byte-identical GSplatData to
 * the original main-thread `loadGSplatData`.
 *
 * Usage: node scripts/probe-load-worker.mjs [model]
 *   model defaults to real-test.ply (must be present in dist/)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// puppeteer-core lives in the managed workspace node_modules (not in this project).
const PUPPETEER_CANDIDATES = [
    'puppeteer-core',
    'puppeteer-core'
];
let puppeteer;
for (const c of PUPPETEER_CANDIDATES) {
    try { puppeteer = require(c); break; } catch { /* try next */ }
}
if (!puppeteer) {
    console.error('puppeteer-core not found in any candidate path');
    process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const MODEL = process.argv[2] || 'real-test.ply';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ply': 'application/octet-stream',
    '.map': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/lw-probe.html';
    const filePath = path.join(DIST, urlPath);
    if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(buf);
    });
});

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const waitForServer = (port, tries = 50) => new Promise((resolve, reject) => {
    const attempt = (n) => {
        const s = http.get({ host: '127.0.0.1', port, path: '/lw-probe.html' }, r => { r.resume(); resolve(); });
        s.on('error', () => {
            if (n <= 0) reject(new Error('server did not start'));
            else setTimeout(() => attempt(n - 1), 100);
        });
    };
    attempt(tries);
});

const main = async () => {
    await new Promise(r => server.listen(3000, '127.0.0.1', r));
    await waitForServer(3000);
    console.log('server up on :3000');

    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-swiftshader',
            '--use-gl=angle',
            '--use-angle=swiftshader'
        ]
    });
    const page = await browser.newPage();
    page.on('console', m => console.log('PAGE:', m.text()));
    page.on('pageerror', e => console.log('PAGEERROR:', e.message));

    const url = `http://127.0.0.1:3000/lw-probe.html?model=${encodeURIComponent(MODEL)}`;
    console.log('goto', url);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    await page.waitForFunction('window.__PROBE_RESULT__ !== undefined', { timeout: 60000 });
    const result = await page.evaluate('window.__PROBE_RESULT__');
    console.log('RESULT:', JSON.stringify(result, null, 1));

    await browser.close();
    server.close();

    if (!result || !result.ok) {
        console.error('PROBE FAILED');
        process.exit(1);
    }
    console.log('PROBE OK');
};

main().catch(e => { console.error('PROBE ERROR:', e); server.close(); process.exit(1); });
