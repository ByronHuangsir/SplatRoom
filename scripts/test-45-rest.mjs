import fs from 'fs';
import { Column, DataTable, MemoryFileSystem, writeFile, readFile, createChunkDataPool, materializeToDataTable } from '@playcanvas/splat-transform';

const N = 3;
const cols = [];
const add = (name, vals) => cols.push(new Column(name, Float32Array.from(vals)));
add('x', [0,1,2]); add('y',[0,0,0]); add('z',[0,0,0]);
add('rot_0',[1,1,1]); add('rot_1',[0,0,0]); add('rot_2',[0,0,0]); add('rot_3',[0,0,0]);
add('scale_0',[0,0,0]); add('scale_1',[0,0,0]); add('scale_2',[0,0,0]);
add('opacity',[0,0,0]);
add('f_dc_0',[0,0,0]); add('f_dc_1',[0,0,0]); add('f_dc_2',[0,0,0]);
for (let i=0;i<45;i++) add(`f_rest_${i}`, new Array(N).fill(0));
const dt = new DataTable(cols);
const mem = new MemoryFileSystem();
await writeFile({ filename:'t.ply', outputFormat:'ply', dataTable: dt, options:{}, createDevice: undefined }, mem);
const data = mem.results.get('t.ply');
fs.writeFileSync('C:/tmp/test45.ply', Buffer.from(data));
console.log('wrote', data.length, 'bytes');

// parse back with node fs
class NodeFs {
  async createSource(filename) {
    const fd = fs.openSync(filename, 'r');
    const size = fs.fstatSync(fd).size;
    return { size, seekable: true, read(start=0, end=size) {
      const len = end-start; const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start);
      const u = new Uint8Array(buf.buffer, buf.byteOffset, len); let br=0; let closed=false;
      return { expectedSize: len, bytesRead:0, async pull(t){ if(closed) return 0; const n=Math.min(t.length, u.length-br); if(n<=0) return 0; t.set(u.subarray(br,br+n),0); br+=n; return n;}, async readAll(){return u;}, close(){closed=true;} };
    }, close(){ fs.closeSync(fd); } };
  }
}
try {
  const sources = await readFile({ filename:'C:/tmp/test45.ply', inputFormat:'ply', options:{iterations:10,lodSelect:[],unbundled:false,lodChunkCount:512,lodChunkExtent:16}, params:[], fileSystem: new NodeFs() });
  const pool = createChunkDataPool({ chunkSize: sources[0].meta.chunkSize });
  const dt2 = await materializeToDataTable(sources[0], pool);
  const rest = dt2.columns.filter(c=>/^f_rest_/.test(c.name)).length;
  console.log('PARSE OK, f_rest columns =', rest);
  pool.destroy(); for (const s of sources) await s.close();
} catch(e) { console.log('PARSE ERROR', e.message); }
