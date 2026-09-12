import { Column, DataTable, MemoryFileSystem, writeFile, readFile, createChunkDataPool, materializeToDataTable } from '@playcanvas/splat-transform';
const N = 2;
const cols = [];
const add = (name, vals) => cols.push(new Column(name, Float32Array.from(vals)));
add('x', [0,1]); add('y',[0,0]); add('z',[0,0]);
add('rot_0',[1,1]); add('rot_1',[0,0]); add('rot_2',[0,0]); add('rot_3',[0,0]);
add('scale_0',[0,0]); add('scale_1',[0,0]); add('scale_2',[0,0]);
add('opacity',[0,0]);
add('f_dc_0',[0,0]); add('f_dc_1',[0,0]); add('f_dc_2',[0,0]);
// standard interleaved 15 f_rest
for (let i=0;i<15;i++) add(`f_rest_${i}`, [0,0]);
const dt = new DataTable(cols);
const fs = new MemoryFileSystem();
await writeFile({ filename:'t.ply', outputFormat:'ply', dataTable: dt, options:{}, createDevice: undefined }, fs);
const data = fs.results.get('t.ply');
const endIdx = Buffer.from(data).indexOf(Buffer.from('end_header'));
const header = Buffer.from(data).slice(0, endIdx+20).toString('latin1');
console.log('--- WRITTEN HEADER ---');
console.log(header);
// now try to read it back
try {
  const sources = await readFile({ filename:'t.ply', inputFormat:'ply', options:{iterations:10,lodSelect:[],unbundled:false,lodChunkCount:512,lodChunkExtent:16}, params:[], fileSystem: fs });
  const pool = createChunkDataPool({ chunkSize: sources[0].meta.chunkSize });
  const dt2 = await materializeToDataTable(sources[0], pool);
  console.log('READ OK cols:', dt2.columns.map(c=>c.name).join(','));
  pool.destroy();
  for (const s of sources) await s.close();
} catch(e) {
  console.log('READ ERROR', e.message);
}
