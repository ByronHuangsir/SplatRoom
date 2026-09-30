// 查看器单文件 HTML 的"流式组装"与官方 bundle writer 的对拍（本会话目标：去掉 O(输出) 的瞬时分配）。
//
// 背景：splat-transform 的 `html-bundle` 分支会把整包 base64 成巨型字符串再拼 HTML
// （writeSource default → materializeToDataTable → writeSog 到 MemoryFileSystem → toBase64
//  → renderViewerHtml → TextEncoder）。1300 万点实测瞬时 ≥8MB 分配合计 4251.5MB、单次最大 396.9MB。
// 我们改成：用假数据取一次 viewer 模板 → 按同一批接缝内联 → .sog 边产出边 base64 直接流进输出流。
//
// 这**不应该改变产物**，所以这里做三件事：
//   1) 用 winodw.__SPLATROOM_VIEWER_STREAM__ 分别跑"流式"和"官方 writer"，抓真实输出字节对拍：
//      把 data URI 载荷挖掉后，两份 HTML 必须**逐字节相同**（内联方式、bootstrap JSON、settings 全一致）；
//   2) 两份载荷长度相同，且 base64 解码后都是一个合法的 ZIP；把 ZIP 条目逐个解出来比
//      条目名 / 未压缩长度 / 内容摘要 —— 容器时间戳会差，所以比内容而不是比整包字节；
//   3) 流式那条路是真的走了（没有退回 warning），并且产出的单文件 HTML 能在浏览器里打开、
//      viewer 起得来、控制台没有报错。
//
// usage: node docs/verify/verify-viewer-stream.cjs [url] [model]
const puppeteer = require('puppeteer-core');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { URL: NodeURL } = require('node:url');

const { BROWSER_PATH: EDGE , launchPatched: _launchPatched } = require('./lib/browser.cjs');
const TARGET = process.argv[2] || 'http://localhost:3621/?gpu=webgpu';
const MODEL = process.argv[3] || 'test-model.ply';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// 最小 ZIP 读取：条目信息一律以中央目录为准（流式 writer 会在本地头留 0 长度 + data descriptor）
const parseZip = (buf) => {
    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= lowest; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('no EOCD');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central directory header at ${off}`);
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const uncompSize = buf.readUInt32LE(off + 24);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        const lnameLen = buf.readUInt16LE(localOff + 26);
        const lextraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lnameLen + lextraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
        entries.push({ name, method, size: data.length, sha1: sha1(data), data });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

(async () => {
    const browser = await _launchPatched(puppeteer, { executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], protocolTimeout: 900000 });
    const errors = [];
    const warnings = [];
    let out = null;
    const served = path.join(__dirname, '..', '..', 'dist', '_verify-viewer-stream.html');
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
        page.on('console', (m) => {
            const text = m.text();
            if (m.type() === 'error') errors.push('console: ' + text.slice(0, 200));
            if (m.type() === 'warning') warnings.push(text.slice(0, 300));
        });

        await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction('!!window.scene', { timeout: 60000 });
        await sleep(1500);

        await page.evaluate(async (m) => {
            const buf = await (await fetch('./' + m)).arrayBuffer();
            await window.scene.events.invoke('import', [{ filename: m, contents: new File([buf], m) }]);
        }, MODEL);
        await page.waitForFunction("window.scene.getElementsByType('splat').length > 0", { timeout: 90000, polling: 300 });
        await sleep(2500);

        const result = await page.evaluate(async () => {
            const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));
            const scene = window.scene;
            const encoder = new TextEncoder();

            // 抓真实输出字节的假 stream（file-handler 会把它当 FileSystemWritableFileStream 用）
            const makeCapture = () => {
                const chunks = [];
                let size = 0;
                return {
                    seek: async () => {},
                    write: async (d) => {
                        const u8 = d instanceof Uint8Array ? d : new Uint8Array(d);
                        chunks.push(u8.slice());
                        size += u8.byteLength;
                    },
                    truncate: async () => {},
                    close: async () => {},
                    abort: async () => {},
                    bytes: () => size,
                    concat: () => {
                        const all = new Uint8Array(size);
                        let off = 0;
                        for (const c of chunks) {
                            all.set(c, off);
                            off += c.byteLength;
                        }
                        return all;
                    }
                };
            };

            const exportOnce = async (streaming, type) => {
                window.__SPLATROOM_VIEWER_STREAM__ = streaming;
                const cap = makeCapture();
                let err = null;
                try {
                    await Promise.race([
                        scene.events.invoke('scene.write', type === 'zip' ? 'packageViewer' : 'htmlViewer', {
                            filename: type === 'zip' ? 'output.zip' : 'output.html',
                            splatIdx: 'all',
                            serializeSettings: { maxSHBands: 3 },
                            viewerExportSettings: { type, background: '#000000' }
                        }, cap),
                        sleep2(300000)
                    ]);
                } catch (e) {
                    err = String(e).slice(0, 300);
                }
                return { cap, err };
            };

            const toB64 = (bytes) => {
                let binary = '';
                const STEP = 3 * 8192;
                for (let i = 0; i < bytes.length; i += STEP) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
                }
                return btoa(binary);
            };

            const summarize = (bytes) => {
                // 整包 base64 回传（小模型 ~3MB），Node 侧全程按真字节比对 —— 不经过 JS 字符串，
                // 免得 TextDecoder 把非法序列换成 U+FFFD 这种往返损耗混进结论里。
                const text = new TextDecoder().decode(bytes);
                return {
                    length: bytes.byteLength,
                    full: toB64(bytes),
                    hasPayload: text.includes('data:application/octet-stream;base64,'),
                    leftoverPlaceholder: text.includes('SPLATROOM_SOG_PAYLOAD_PLACEHOLDER'),
                    bootstrapCount: (text.match(/id="sse-bootstrap"/g) || []).length,
                    inlineStyle: text.includes('<style>'),
                    inlineModule: !text.includes("from './index.js'")
                };
            };

            // 先跑流式（默认路），再跑官方 writer
            const streamed = await exportOnce(true, 'html');
            const official = await exportOnce(false, 'html');
            // 打包（zip）那条路同样对拍；zip 里带容器时间戳，所以比条目内容而不是整包字节
            const streamedZip = await exportOnce(true, 'zip');
            const officialZip = await exportOnce(false, 'zip');
            window.__SPLATROOM_VIEWER_STREAM__ = undefined;

            const zipSummary = (r) => (r.err ?
                { err: r.err } :
                { err: null, length: r.cap.bytes(), full: toB64(r.cap.concat()) });

            return {
                streamed: streamed.err ? { err: streamed.err } : summarize(streamed.cap.concat()),
                official: official.err ? { err: official.err } : summarize(official.cap.concat()),
                zip: { streamed: zipSummary(streamedZip), official: zipSummary(officialZip) }
            };
        });

        if (result.streamed.err || result.official.err) {
            out = { result, checks: [], failed: 1, errors };
            throw new Error(`export failed: ${JSON.stringify({ streamed: result.streamed.err, official: result.official.err })}`);
        }

        // 注意：viewer 自己的 JS 里就含 "data:application/octet-stream;base64," 这个字面量，
        // 所以不能只找前缀 —— 必须找 bootstrap 里那一处 `contentUrl":"<前缀>`
        const PREFIX = Buffer.from('contentUrl":"data:application/octet-stream;base64,', 'latin1');
        // 从真字节里切出载荷（base64 之后紧跟的是 JSON 字符串的收尾引号）
        const split = (s) => {
            const bytes = Buffer.from(s.full, 'base64');
            const at = bytes.indexOf(PREFIX);
            const end = at === -1 ? -1 : bytes.indexOf(0x22, at + PREFIX.length);
            if (at === -1 || end === -1) {
                return { bytes, ok: false };
            }
            const payloadStart = at + PREFIX.length;
            const b64 = bytes.subarray(payloadStart, end);
            return {
                bytes,
                ok: true,
                b64Length: b64.length,
                payload: Buffer.from(b64.toString('latin1'), 'base64'),
                stripped: Buffer.concat([bytes.subarray(0, payloadStart), bytes.subarray(end)])
            };
        };

        const zipOf = (payload) => parseZip(payload);

        let zipEntries = null;
        let officialEntries = null;
        let zipErr = null;
        const A = split(result.streamed);
        const B = split(result.official);
        try {
            zipEntries = zipOf(A.payload);
            officialEntries = zipOf(B.payload);
        } catch (e) {
            zipErr = String(e).slice(0, 200);
        }

        const sameEntries = zipEntries && officialEntries &&
            zipEntries.length === officialEntries.length &&
            zipEntries.every((e, i) => e.name === officialEntries[i].name && e.size === officialEntries[i].size && e.sha1 === officialEntries[i].sha1);

        // 逐字节相同的判定：给出第一处分歧与前后文，省得只看到一个长度差
        const sa = A.stripped;
        const sb = B.stripped;
        let diffAt = -1;
        const minLen = Math.min(sa.length, sb.length);
        for (let i = 0; i < minLen; i++) {
            if (sa[i] !== sb[i]) {
                diffAt = i;
                break;
            }
        }
        if (diffAt === -1 && sa.length !== sb.length) {
            diffAt = minLen;
        }
        const firstDiff = diffAt === -1 ? null : {
            at: diffAt,
            streamed: sa.subarray(Math.max(0, diffAt - 100), diffAt + 160).toString('utf8'),
            official: sb.subarray(Math.max(0, diffAt - 100), diffAt + 160).toString('utf8')
        };

        // 功能校验：把两份产物都放到站点目录里打开，看行为是否一致（viewer 起不起得来、报不报错）
        const openHtml = async (tag, htmlBytes) => {
            const file = path.join(__dirname, '..', '..', 'dist', `_verify-viewer-stream-${tag}.html`);
            fs.writeFileSync(file, htmlBytes);
            const p2 = await browser.newPage();
            const err2 = [];
            p2.on('pageerror', e => err2.push(String(e).slice(0, 200)));
            let state = { error: null };
            try {
                await p2.goto(new NodeURL(path.basename(file), TARGET).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await sleep(12000);
                state = await p2.evaluate(() => ({
                    error: null,
                    canvas: !!document.querySelector('canvas'),
                    title: document.title,
                    bodyText: (document.body.innerText || '').slice(0, 80)
                }));
            } catch (e) {
                state = { error: String(e).slice(0, 300) };
            } finally {
                await p2.close();
                try {
                    fs.unlinkSync(file);
                } catch { /* 可能没写成功 */ }
            }
            return { tag, writtenBytes: htmlBytes.length, ...state, errors: err2 };
        };

        const openedStreamed = await openHtml('streamed', A.bytes);
        const openedOfficial = await openHtml('official', B.bytes);
        // 报错签名里含文件名，去掉 tag 再比
        const errSig = (o) => JSON.stringify((o.errors || []).map(e => e.replace(/streamed|official/g, '#').replace(/\d+/g, '#')));
        const sameBehaviour = errSig(openedStreamed) === errSig(openedOfficial) &&
            openedStreamed.canvas === openedOfficial.canvas;
        const opened = openedStreamed;

        const fallbackWarnings = warnings.filter(w => /viewer stream|viewer template unavailable/i.test(w));

        // 打包（zip）对拍：条目名与顺序、每个条目的解压长度与内容摘要；
        // 里面的 index.sog 本身是个带时间戳的 zip，所以那一项递归比"形状"
        const zipShape = (buf, depth = 0) => {
            const list = parseZip(buf);
            return list.map(e => ({
                name: e.name,
                size: e.size,
                inner: depth < 1 && /\.sog$/.test(e.name) ? zipShape(e.data, depth + 1) : null,
                sha1: depth < 1 && /\.sog$/.test(e.name) ? null : e.sha1
            }));
        };

        let zipCompare = null;
        let zipErr2 = null;
        try {
            const ZA = Buffer.from(result.zip.streamed.full, 'base64');
            const ZB = Buffer.from(result.zip.official.full, 'base64');
            const shapeA = zipShape(ZA);
            const shapeB = zipShape(ZB);
            zipCompare = {
                streamedLength: ZA.length,
                officialLength: ZB.length,
                names: shapeA.map(e => `${e.name}:${e.size}`),
                same: JSON.stringify(shapeA) === JSON.stringify(shapeB)
            };
        } catch (e) {
            zipErr2 = String(e).slice(0, 200);
        }

        const checks = [
            {
                name: '★ 流式与官方 writer 的 HTML（挖掉 data URI 载荷后）逐字节相同',
                pass: A.ok && B.ok && sa.equals(sb),
                detail: `流式 ${result.streamed.length} B / 官方 ${result.official.length} B，载荷 ${A.payload ? A.payload.length : -1} vs ${B.payload ? B.payload.length : -1} 字节` +
                    (firstDiff ? `，第一处分歧 @${firstDiff.at}\n  流式: ${JSON.stringify(firstDiff.streamed)}\n  官方: ${JSON.stringify(firstDiff.official)}` : '')
            },
            {
                name: '★ 两份载荷长度相同（同一份 .sog 字节数）',
                pass: !!A.payload && !!B.payload && A.payload.length === B.payload.length,
                detail: `${A.payload ? A.payload.length : -1} vs ${B.payload ? B.payload.length : -1}`
            },
            {
                name: '★ 载荷是合法 ZIP，且解出的条目名/长度/内容摘要与官方路径完全一致',
                pass: !!zipEntries && sameEntries,
                detail: zipErr ? `解析失败 ${zipErr}` : JSON.stringify((zipEntries || []).map(e => `${e.name}:${e.size}`))
            },
            {
                name: '单文件 HTML 自身结构正确（有 bootstrap、css 内联、没有残留 index.js 引用与占位符）',
                pass: result.streamed.bootstrapCount === 1 && result.streamed.inlineStyle === true &&
                    result.streamed.inlineModule === true && result.streamed.leftoverPlaceholder === false,
                detail: JSON.stringify({ bootstrap: result.streamed.bootstrapCount, style: result.streamed.inlineStyle, module: result.streamed.inlineModule, placeholder: result.streamed.leftoverPlaceholder })
            },
            {
                name: '★ 产出的单文件 HTML 落盘字节数与导出字节数一致（原样落盘、没有被改写）',
                pass: openedStreamed.writtenBytes === A.bytes.length && openedOfficial.writtenBytes === B.bytes.length,
                detail: `流式 ${openedStreamed.writtenBytes} vs ${A.bytes.length}；官方 ${openedOfficial.writtenBytes} vs ${B.bytes.length}`
            },
            {
                name: '★ 两份产物在浏览器里打开的表现一致（viewer 起得来、报错签名相同）',
                pass: sameBehaviour && openedStreamed.canvas === true,
                detail: JSON.stringify({ streamed: openedStreamed, official: openedOfficial })
            },
            {
                name: '★ 走的是流式那条路（没有"退回官方 writer"的 warning）',
                pass: fallbackWarnings.length === 0,
                detail: fallbackWarnings.length ? fallbackWarnings.join(' | ') : '无退回 warning'
            },
            {
                name: '★ 打包（zip）产物与官方 writer 的条目结构一致（名字/顺序/内容摘要；内层 .sog 递归比形状）',
                pass: !!zipCompare && zipCompare.same === true,
                detail: zipErr2 ? `解析失败 ${zipErr2}` : JSON.stringify(zipCompare)
            }
        ];

        out = { result: { ...result, streamed: { ...result.streamed, full: undefined }, official: { ...result.official, full: undefined }, zip: { streamedLength: result.zip.streamed.length, officialLength: result.zip.official.length, streamedErr: result.zip.streamed.err, officialErr: result.zip.official.err }, zipEntries, zipCompare, firstDiff, opened: { streamed: openedStreamed, official: openedOfficial } }, checks, failed: checks.filter(c => !c.pass).length, errors };
    } catch (err) {
        if (!out) {
            out = { fatal: String(err).slice(0, 600), errors, failed: 1 };
        }
    } finally {
        await browser.close();
    }

    console.log(JSON.stringify(out, null, 2));
    if (out.failed > 0) process.exitCode = 1;
})();
