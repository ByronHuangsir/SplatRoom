const asar = require('@electron/asar');
const P = '.workbuddy/debug-shots/asar_extract/resources/app.asar';
const code = asar.extractFile(P, 'dist/index.js').toString();

// print all _suppressCropBox occurrences with context
let i = -1;
let n = 0;
while ((i = code.indexOf('_suppressCropBox', i + 1)) !== -1) {
  n++;
  console.log(`\n##### occurrence ${n} @${i} #####`);
  console.log(code.slice(i - 350, i + 250));
}
console.log('\n=== keyword counts ===');
console.log('finally{ :', code.split('finally{').length - 1);
console.log('try{ :', code.split('try{').length - 1);
console.log('catch{ :', code.split('catch{').length - 1);
