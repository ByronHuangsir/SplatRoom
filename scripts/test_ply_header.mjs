import { Column, DataTable, MemoryFileSystem, writeFile } from '@playcanvas/splat-transform';
const cols = [
  new Column('x', new Float32Array([0,1,2])),
  new Column('y', new Float32Array([0,0,0])),
  new Column('z', new Float32Array([0,0,0])),
  new Column('rot_0', new Float32Array([1,1,1])),
  new Column('rot_1', new Float32Array([0,0,0])),
  new Column('rot_2', new Float32Array([0,0,0])),
  new Column('rot_3', new Float32Array([0,0,0])),
  new Column('scale_0', new Float32Array([0,0,0])),
  new Column('scale_1', new Float32Array([0,0,0])),
  new Column('scale_2', new Float32Array([0,0,0])),
  new Column('opacity', new Float32Array([0,0,0])),
  new Column('f_dc_0', new Float32Array([0,0,0])),
  new Column('f_dc_1', new Float32Array([0,0,0])),
  new Column('f_dc_2', new Float32Array([0,0,0])),
];
const dt = new DataTable(cols);
const fs = new MemoryFileSystem();
await writeFile({ filename:'t.ply', outputFormat:'ply', dataTable: dt, options:{}, createDevice: undefined }, fs);
const data = fs.results.get('t.ply');
const endIdx = Buffer.from(data).indexOf(Buffer.from('end_header'));
const s = Buffer.from(data).slice(0, endIdx+20).toString('latin1');
console.log(s);
