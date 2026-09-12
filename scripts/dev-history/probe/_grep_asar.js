const asar = require('@electron/asar');
const fs = require('fs');
const P = '.workbuddy/debug-shots/asar_extract/resources/app.asar';
const target = 'dist/index.js';
const buf = asar.extractFile(P, target);
const code = buf.toString();
fs.writeFileSync('.workbuddy/debug-shots/asar_dist_index.js', code);
console.log('extracted', target, 'bytes=', code.length);
function count(s) { return code.split(s).length - 1; }
console.log('cropSuppressed :', count('cropSuppressed'));
console.log('_suppressCropBox :', count('_suppressCropBox'));
console.log('splatTextureSize :', count('splatTextureSize'));
console.log('splatOrder :', count('splatOrder'));
console.log('cameras :', count('.cameras'));
// context around _suppressCropBox
const idx = code.indexOf('_suppressCropBox');
if (idx >= 0) {
  console.log('--- context ---');
  console.log(code.slice(idx - 200, idx + 400));
}
