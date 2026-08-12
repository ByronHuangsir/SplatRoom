// minimal static server for seg-lab testing
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/Byon Huang/WorkBuddy/SplatRoom';
const PORT = 3200;

const MIME = {
  '.html':'text/html','.js':'application/javascript','.ply':'application/octet-stream',
  '.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'
};

http.createServer((req,res)=>{
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  if (url.endsWith('/')) url += 'index.html';
  // map /seg-lab/... to seg-lab dir; everything else from ROOT
  let p;
  if (url.startsWith('/seg-lab/')) {
    p = path.join(ROOT, 'seg-lab', url.slice('/seg-lab/'.length));
  } else if (url.startsWith('/node_modules/')) {
    p = path.join(ROOT, url);
  } else {
    p = path.join(ROOT, url);
  }
  fs.readFile(p,(err,data)=>{
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
    res.end(data);
  });
}).listen(PORT,()=>console.log('static server on',PORT));
