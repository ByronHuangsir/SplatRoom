const asar = require('@electron/asar');
const P = '.workbuddy/debug-shots/asar_extract/resources/app.asar';
const files = asar.listPackage(P);
const top = files.filter(f => {
  const parts = f.replace(/^\\/, '').split('\\');
  return parts.length === 1;
});
console.log('TOP-LEVEL entries (' + top.length + '):');
console.log(top.join('\n'));
console.log('--- depth 2 ---');
const d2 = [...new Set(files.map(f => {
  const p = f.replace(/^\\/, '').split('\\');
  return p.slice(0, 2).join('/');
}).filter(x => x.includes('/')))];
console.log(d2.join('\n'));
