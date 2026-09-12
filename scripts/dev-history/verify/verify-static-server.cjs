// verify-static-server.cjs
// 验证 electron-main.js 中 createStaticServer 的安全行为：
//   - 白名单: 只服务 dist/ 与 static/ 下的文件
//   - 目录穿越: ../ 与 URL 编码穿越必须被拒绝（403/404，绝不能返回根目录文件）
//   - 无 CORS 头
// 用法: node scripts/verify-static-server.cjs   （需先 npm run build 生成 dist）
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..');
process.chdir(root);

// 从 electron-main.js 源码中提取 createStaticServer 函数（纯函数，无 electron 依赖）
const src = fs.readFileSync(path.join(root, 'electron-main.js'), 'utf8');

const extractFn = (code, name) => {
    const startMarker = `function ${name}(`;
    const start = code.indexOf(startMarker);
    if (start === -1) throw new Error(`cannot find ${name}`);
    let depth = 0;
    for (let i = start; i < code.length; i++) {
        const c = code[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
};

const extractConst = (code, name) => {
    const startMarker = `const ${name} = `;
    const start = code.indexOf(startMarker);
    if (start === -1) throw new Error(`cannot find ${name}`);
    let depth = 0;
    for (let i = start; i < code.length; i++) {
        const c = code[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
};

const fnText = extractFn(src, 'createStaticServer');
const mimeText = extractConst(src, 'MIME_TYPES');

const mimeEval = new Function(`${mimeText}\nreturn MIME_TYPES;`)();
const createStaticServer = new Function('require', '__dirname', 'path', 'http', 'fs', 'MIME_TYPES', `${fnText}\nreturn createStaticServer;`)(
    require, root, path, http, fs, mimeEval
);

const tests = [
    { name: 'GET /index.html (dist root)', url: '/index.html', expect: 200 },
    { name: 'GET / (SPA)', url: '/', expect: 200 },
    { name: 'GET /static/icons/icon.ico (static/)', url: '/static/icons/icon.ico', expect: 200 },
    { name: 'GET /manifest.json (dist)', url: '/manifest.json', expect: 200 },
    // 白名单外路径: 404 即视为安全（不得返回文件内容）；403 同样通过
    { name: 'GET /electron-main.js (root leak!)', url: '/electron-main.js', expect: 404 },
    { name: 'GET /package.json (root leak!)', url: '/package.json', expect: 404 },
    { name: 'GET /../electron-main.js (traversal)', url: '/../electron-main.js', expect: 404 },
    { name: 'GET /%2e%2e%2felectron-main.js (encoded traversal)', url: '/%2e%2e%2felectron-main.js', expect: 404 },
    { name: 'GET /..%2f..%2fpackage.json (encoded traversal)', url: '/..%2f..%2fpackage.json', expect: 404 },
    { name: 'GET /node_modules/playcanvas/package.json (node_modules leak!)', url: '/node_modules/playcanvas/package.json', expect: 404 },
    // 无扩展名路径命中 SPA fallback → 返回 index.html（不含任何敏感内容）
    { name: 'GET /release (SPA fallback, not dir listing)', url: '/release', expect: 200, bodyShouldContain: '<!DOCTYPE html>' },
    { name: 'GET /nonexistent.js', url: '/nonexistent.js', expect: 404 },
    { name: 'GET /some/route (SPA fallback)', url: '/some/route', expect: 200 }
];

let failures = 0;
const run = (port) => {
    let i = 0;
    const next = () => {
        if (i >= tests.length) {
            console.log(failures === 0 ? '\n✔ all security checks passed' : `\n✖ ${failures} check(s) failed`);
            server.close();
            process.exitCode = failures === 0 ? 0 : 1;
            return;
        }
        const t = tests[i++];
        http.get({ host: '127.0.0.1', port, path: t.url }, (res) => {
            const body = [];
            res.on('data', (c) => body.push(c));
            res.on('end', () => {
                const bodyStr = Buffer.concat(body).toString('utf8');
                const pass = res.statusCode === t.expect && (!t.bodyShouldContain || bodyStr.includes(t.bodyShouldContain));
                const snippet = bodyStr.slice(0, 50).replace(/\s+/g, ' ');
                const leak = (!pass && t.expect === 404) ? '  <-- LEAK!' : '';
                console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${res.statusCode} ${t.name}${leak}`);
                if (!pass) {
                    failures++;
                    console.log(`        expected ${t.expect}${t.bodyShouldContain ? ` containing "${t.bodyShouldContain}"` : ''}, body: ${snippet}`);
                } else if (res.headers['access-control-allow-origin']) {
                    failures++;
                    console.log('        WARN: CORS header present on response!');
                }
                next();
            });
        }).on('error', (e) => {
            failures++;
            console.log(`  [FAIL] ${t.name}: request error ${e.message}`);
            next();
        });
    };
    next();
};

const server = createStaticServer();
server.listen(31999, '127.0.0.1', () => run(31999));
