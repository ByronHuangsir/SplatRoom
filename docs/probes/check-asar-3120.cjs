const asar = require('D:/DeepSeek/SplatRoomV2/SplatRoomV3-0/node_modules/@electron/asar');
const src = 'D:/DeepSeek/SplatRoomV2/SplatRoomV3-0/release/win-unpacked/resources/app.asar';
const raw = asar.listPackage(src).map(f => f.replace(/\\/g, '/').replace(/^\/+/, ''));
const idx = asar.extractFile(src, 'dist/index.js').toString('utf8');
const cssPath = raw.find(f => f.toLowerCase().endsWith('.css'));
const css = asar.extractFile(src, cssPath).toString('utf8');
const versions = new Set();
let m;
const re = /3\.[0-9]+\.[0-9]+/g;
while ((m = re.exec(idx))) versions.add(m[0]);
console.log('entries:', raw.length, '| version literals:', [...versions].join(', '));
console.log('ply entries:', raw.filter(f => /\.ply$/i.test(f)).join(', ') || '(none)');
console.log('wasm files:', raw.filter(f => /\.wasm$/.test(f)).length);
console.log('frozen-drag code in bundle  :', idx.includes('dragGrabValue') && idx.includes('dragView'));
console.log('pan helper in bundle        :', idx.includes('panForValue'));
console.log('min-thickness in bundle     :', idx.includes('MIN_THICKNESS') || idx.includes('0.1'));
console.log('css outer specificity fix   :', css.includes('.select-range-handle.select-range-handle-outer'));
console.log('css fixed-size blocks       :', css.includes('select-range-block'));
const locales = asar.listPackage(src).filter(f => /locales[\\/]zh-CN\.json$/.test(f));
if (locales.length) {
    const j = JSON.parse(asar.extractFile(src, locales[0]).toString('utf8'));
    const flat = [];
    const walk = (o, p) => { for (const k of Object.keys(o)) { const n = p ? p + '.' + k : k; (o[k] && typeof o[k] === 'object') ? walk(o[k], n) : flat.push(n); } };
    walk(j, '');
    console.log('zh-CN flat keys:', flat.length);
}
