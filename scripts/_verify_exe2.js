const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const exePath = process.argv[2];
const data = fs.readFileSync(exePath);
const sig = Buffer.from([0x37,0x7A,0xBC,0xAF,0x27,0x1C]);
const off = data.indexOf(sig);
if (off < 0) { console.log('NO 7z signature found'); process.exit(2); }
console.log('7z payload @', off);

// write the 7z stream to a temp file
const tmp7z = path.join('.workbuddy/debug-shots', 'verify2.7z');
fs.writeFileSync(tmp7z, data.slice(off));

// extract app.asar from the 7z
const outDir = '.workbuddy/debug-shots/verify2_asar';
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const { execSync } = require('child_process');
// use 7zip? not available. Use a node 7z? Use py7zr via python venv
const py = 'C:/Users/Byon Huang/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const pyScript = `
import py7zr, sys
with py7zr.SevenZipFile(r'${tmp7z.replace(/\\/g,'\\\\')}', 'r') as z:
    z.extract(path=r'${outDir.replace(/\\/g,'\\\\')}', targets=['resources/app.asar'])
print('extracted app.asar')
`;
fs.writeFileSync('.workbuddy/debug-shots/_extract.py', pyScript);
execSync(`"${py}" .workbuddy/debug-shots/_extract.py`).toString();

const asarPath = path.join(outDir, 'resources', 'app.asar');
// extract dist/index.css
let css;
try {
  css = asar.extractFile(asarPath, 'dist/index.css').toString();
} catch (e) {
  console.log('extractFile dist/index.css failed:', e.message);
  // list candidates
  const files = asar.listPackage(asarPath);
  const cssFiles = files.filter(f => f.endsWith('index.css'));
  console.log('index.css candidates:', cssFiles);
  process.exit(3);
}

const checks = {
  'timeline height:220px': css.includes('height: 220px'),
  'timeline max-height:45vh': css.includes('max-height: 45vh'),
  'timeline opacity: 0.9': css.includes('opacity: 0.9'),
  'data height:240px': css.includes('height: 240px'),
  'data opacity: 0.9': css.includes('opacity: 0.9'),
};
console.log('=== CSS checks inside new exe ===');
for (const [k,v] of Object.entries(checks)) console.log((v?'PASS':'FAIL')+' - '+k);

// also confirm the PiP fix still present in dist/index.js
let js;
try { js = asar.extractFile(asarPath, 'dist/index.js').toString(); } catch(e){ js=''; }
const pipFix = (js.match(/_suppressCropBox\(!1\)/g)||[]).length === 2;
console.log((pipFix?'PASS':'FAIL')+' - PiP fix (_suppressCropBox(!1) x2) still present');
