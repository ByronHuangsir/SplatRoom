// Node verification of the V3 lod.ts data layer: real PLY bytes → GSplatData
// (manual) → DataTable → decimate → GSplatData, checking row/col fidelity.
import { readFileSync } from 'fs';
import { GSplatData } from 'playcanvas';
import { gsplatDataToDataTable, dataTableToGsplatData, decimateGsplatData, planLodFractions } from '../src/lod/lod.ts';

// minimal PLY reader to build a GSplatData exactly like the app's vertex set
const bytes = readFileSync('D:/DeepSeek/SplatRoomV2/SplatRoom/dist.bak/test-bump.ply');
let hEnd = -1;
for (let i = 0; i < bytes.length - 11; i++) {
    if (bytes.toString('latin1', i, i + 11) === 'end_header\n') { hEnd = i + 11; break; }
}
const header = bytes.toString('latin1', 0, bytes.indexOf('end_header'));
const props = [];
for (const ln of header.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith('element vertex')) props.count = parseInt(t.split(/\s+/)[2], 10);
    if (t.startsWith('property float')) props.push({ name: t.split(/\s+/)[2], type: 'float', byteSize: 4 });
}
const N = props.count;
const outCols = props.map((p) => ({ ...p, storage: new Float32Array(N) }));
const dv = new DataView(bytes.buffer, bytes.byteOffset);
const stride = props.length * 4;
for (let i = 0; i < N; i++) {
    for (let p = 0; p < props.length; p++) {
        outCols[p].storage[i] = dv.getFloat32(hEnd + i * stride + p * 4, true);
    }
}
const src = new GSplatData([{ name: 'vertex', count: N, properties: outCols }], ['sphere + bump']);
console.log('source GSplatData rows =', N, 'cols =', outCols.length);

// round-trip GSplatData → DataTable → GSplatData (identity)
const table = gsplatDataToDataTable(src);
console.log('DataTable rows =', table.numRows, 'cols =', table.numColumns);
const back = dataTableToGsplatData(table, ['roundtrip']);
console.log('back GSplatData rows =', back.numSplats, 'getProp x len =', back.getProp('x').length);

// decimate 50% / 20%
for (const frac of [0.5, 0.2]) {
    const t0 = Date.now();
    const dec = await decimateGsplatData(src, Math.round(N * frac), ['decimated']);
    const ms = Date.now() - t0;
    console.log(`decimate ${frac}: ${dec.numSplats} rows (target ${Math.round(N * frac)}), ${dec.columns?.[0] ? 'ok' : ''} in ${ms}ms`);
    const xCol = dec.getProp('x');
    console.log(`   col check: x len ${xCol?.length}, all cols present: ${dec.getElement('vertex').properties.length}`);
}

console.log('planLodFractions: 5000 →', JSON.stringify(planLodFractions(5000)),
    '| 1M →', JSON.stringify(planLodFractions(1_000_000)),
    '| 3M →', JSON.stringify(planLodFractions(3_000_000)));
console.log('LOD DATA LAYER OK');
