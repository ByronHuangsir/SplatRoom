// Diagnostic: recompute detectOutliers' score inline in the page using real splat data.
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = 'http://localhost:3000/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: EDGE, headless: 'new',
        args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1000,700']
    });
    const page = await browser.newPage();
    try {
        await page.goto(BASE + '?load=/test.ply&filename=test.ply', { waitUntil: 'networkidle0', timeout: 60000 });
        let loaded = false;
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            loaded = await page.evaluate(`(() => { const sc = window.scene; if (!sc) return false; for (const e of sc.elements) if (e.type==='splat' && e.splatData) return true; return false; })()`);
            if (loaded) break;
        }
        console.log('loaded:', loaded);
        await sleep(1000);

        const diag = await page.evaluate(`(() => {
            const sc = window.scene;
            const splat = sc.elements.find(e => e.type === 'splat');
            const d = splat.splatData;
            const x = d.getProp('x'), y = d.getProp('y'), z = d.getProp('z');
            const s0 = d.getProp('scale_0'), s1 = d.getProp('scale_1'), s2 = d.getProp('scale_2');
            const N = d.numSplats;
            let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,minZ=1e9,maxZ=-1e9;
            for (let i=0;i<N;i++){ if(x[i]<minX)minX=x[i]; if(x[i]>maxX)maxX=x[i]; if(y[i]<minY)minY=y[i]; if(y[i]>maxY)maxY=y[i]; if(z[i]<minZ)minZ=z[i]; if(z[i]>maxZ)maxZ=z[i]; }
            const diag = Math.hypot(maxX-minX,maxY-minY,maxZ-minZ);
            const cellSize = Math.max(diag*0.015, 1e-6), invCell = 1/cellSize;
            const ms = new Float32Array(N);
            for (let i=0;i<N;i++) ms[i] = Math.max(Math.exp(s0[i]), Math.exp(s1[i]), Math.exp(s2[i]));
            const key = (cx,cy,cz) => { let h = ((cx & 0xFFFF) * 16777619) ^ ((cy & 0xFFFF) * 16777619 + 0x9E3779B9); h = (h * 16777619) ^ ((cz & 0xFFFF) * 16777619); return h >>> 0; };
            const cellStats = new Map();
            const cellX = new Int32Array(N), cellY = new Int32Array(N), cellZ = new Int32Array(N);
            for (let i=0;i<N;i++){
                const cx=Math.floor(x[i]*invCell), cy=Math.floor(y[i]*invCell), cz=Math.floor(z[i]*invCell);
                cellX[i]=cx; cellY[i]=cy; cellZ[i]=cz;
                const k=key(cx,cy,cz); let s=cellStats.get(k); if(!s){s={c:0,sum:0};cellStats.set(k,s);} s.c++; s.sum+=ms[i];
            }
            const out = [];
            const step = Math.max(1, Math.floor(N/8));
            for (let idx=0; idx<N; idx+=step){
                let lc=0, ls=0;
                for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++){
                    const s=cellStats.get(key(cellX[idx]+dx,cellY[idx]+dy,cellZ[idx]+dz));
                    if (s && s.c>0){ lc+=s.c; ls+=s.sum; }
                }
                lc-=1; ls-=ms[idx];
                const lavg = lc>0?ls/lc:ms[idx];
                const score = lavg>0?ms[idx]/lavg:1;
                out.push({i:idx, ms:+ms[idx].toFixed(4), lavg:+lavg.toFixed(4), score:+score.toFixed(2), isOut: score>1.5});
            }
            let outCount = 0;
            for (let i=0;i<N;i++){
                let lc=0, ls=0;
                for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++) for (let dz=-1;dz<=1;dz++){
                    const s=cellStats.get(key(cellX[i]+dx,cellY[i]+dy,cellZ[i]+dz));
                    if (s && s.c>0){ lc+=s.c; ls+=s.sum; }
                }
                lc-=1; ls-=ms[i];
                const lavg = lc>0?ls/lc:ms[i];
                const score = lavg>0?ms[i]/lavg:1;
                if (score > 1.5) outCount++;
            }
            return JSON.stringify({ N, diag:+diag.toFixed(3), cellSize:+cellSize.toFixed(4), cells: cellStats.size, outlierCount_15: outCount, samples: out });
        })()`);
        console.log(diag);
    } catch (err) {
        console.log('ERR', String(err).slice(0, 200));
    } finally {
        await browser.close();
    }
})();
