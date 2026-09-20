const path = require('path');
const asar = require('@electron/asar');
const src = path.join(__dirname, '..', '..', 'release', 'win-unpacked', 'resources', 'app.asar');
const raw = asar.listPackage(src).map(f => f.replace(/\\/g, '/').replace(/^\/+/, ''));

// `@electron/asar` entry names come back from listPackage() with backslashes and a LEADING separator
// (e.g. `\dist\static\locales\zh-CN.json`), and extractFile() cannot resolve a leading separator —
// it fails with `"..." was not found in this archive`. Single-level names like `dist/index.js` happen
// to work with forward slashes, which is what makes this trap intermittent. Try the variants.
const readEntry = (name) => {
    const candidates = [name, name.replace(/^[\\/]+/, ''), name.replace(/\\/g, '/').replace(/^\/+/, '')];
    let lastError = null;
    for (const candidate of candidates) {
        try {
            return asar.extractFile(src, candidate);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
};

const idx = readEntry('dist/index.js').toString('utf8');
const cssPath = raw.find(f => f.toLowerCase().endsWith('.css'));
const css = readEntry(cssPath).toString('utf8');
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
    const j = JSON.parse(readEntry(locales[0]).toString('utf8'));
    const flat = [];
    const walk = (o, p) => { for (const k of Object.keys(o)) { const n = p ? p + '.' + k : k; (o[k] && typeof o[k] === 'object') ? walk(o[k], n) : flat.push(n); } };
    walk(j, '');
    console.log('zh-CN flat keys:', flat.length);
}
