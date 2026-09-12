import fs from 'fs';
import {
  readFile, createChunkDataPool, materializeToDataTable, selectLod, Column, DataTable
} from '@playcanvas/splat-transform';

class NodeReadFileSystem {
  async createSource(filename) {
    const fd = fs.openSync(filename, 'r');
    const size = fs.fstatSync(fd).size;
    return {
      size,
      seekable: true,
      read(start = 0, end = size) {
        const length = end - start;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        const u = new Uint8Array(buf.buffer, buf.byteOffset, length);
        let closed = false;
        let bytesRead = 0;
        return {
          expectedSize: length,
          bytesRead: 0,
          async pull(target) {
            if (closed) return 0;
            const n = Math.min(target.length, u.length - bytesRead);
            if (n <= 0) return 0;
            target.set(u.subarray(bytesRead, bytesRead + n), 0);
            bytesRead += n;
            return n;
          },
          async readAll() { return u; },
          close() { closed = true; }
        };
      },
      close() { fs.closeSync(fd); }
    };
  }
}

const options = { iterations: 10, lodSelect: [], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };
const fs2 = new NodeReadFileSystem();
const filePath = process.argv[2] || 'merged.ply';
try {
  const sources = await readFile({ filename: filePath, inputFormat: 'ply', options, params: [], fileSystem: fs2 });
  console.log('sources', sources.length, 'meta', JSON.stringify(sources[0].meta));
  const pool = createChunkDataPool({ chunkSize: sources[0].meta.chunkSize });
  const dt = await materializeToDataTable(sources[0], pool);
  console.log('numRows', dt.numRows, 'cols', dt.columns.map(c=>c.name+':'+c.dataType).join(','));
  pool.destroy();
  for (const s of sources) await s.close();
  console.log('PARSE_OK');
} catch (e) {
  console.log('PARSE_ERROR', e && e.message ? e.message : e);
}
