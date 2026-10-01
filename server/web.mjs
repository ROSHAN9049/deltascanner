import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3000);
const worker = spawn(process.execPath, [path.join(ROOT, 'worker', 'index.mjs')], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit'
});

let shuttingDown = false;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
};

function parseQuery(url) { return Object.fromEntries(url.searchParams.entries()); }

function createResponse(res) {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { res.setHeader(name, value); return this; },
    json(value) { if (!res.writableEnded) { res.statusCode = this.statusCode || 200; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(value)); } },
    send(value) { if (!res.writableEnded) { res.statusCode = this.statusCode || 200; res.end(value); } },
    end(value='') { if (!res.writableEnded) { res.statusCode = this.statusCode || 200; res.end(value); } }
  };
}

async function readBody(req) {
  if (!['POST','PUT','PATCH'].includes(req.method)) return undefined;
  const chunks=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return undefined;
  const raw=Buffer.concat(chunks).toString('utf8'); if (!raw) return undefined;
  if (String(req.headers['content-type']||'').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

async function handleApi(req,res,url) {
  const handlers = {
    '/api/market':'../api/market.js',
    '/api/health':'../api/health.js',
    '/api/engine/state':'../api/engine/state.js',
    '/api/engine/toggle':'../api/engine/toggle.js'
  };
  const target=handlers[url.pathname]; if (!target) return false;
  try {
    const body=await readBody(req);
    const handler=(await import(target,{with:{type:'module'}})).default;
    await handler({method:req.method,headers:req.headers,query:parseQuery(url),body},createResponse(res));
  } catch (error) {
    if (!res.writableEnded) {
      res.statusCode=503; res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({success:false,environment:'TESTNET',error:error?.message||'API unavailable'}));
    }
  }
  return true;
}

async function serveStatic(req,res,url) {
  if (req.method!=='GET' && req.method!=='HEAD') {
    res.statusCode=405; res.setHeader('Allow','GET, HEAD'); res.end('Method Not Allowed'); return;
  }
  let pathname=decodeURIComponent(url.pathname); if (pathname==='/') pathname='/index.html';
  const candidate=path.normalize(path.join(DIST,pathname));
  const inside=candidate===DIST || candidate.startsWith(DIST+path.sep);
  let filePath=inside?candidate:path.join(DIST,'index.html');
  try {
    let stat; try { stat=await fs.stat(filePath); } catch { stat=null; }
    if (!stat?.isFile()) filePath=path.join(DIST,'index.html');
    const data=await fs.readFile(filePath);
    res.statusCode=200; res.setHeader('Content-Type',MIME[path.extname(filePath).toLowerCase()]||'application/octet-stream');
    res.setHeader('Cache-Control',filePath.endsWith('index.html')?'no-store':'public, max-age=31536000, immutable');
    if (req.method==='HEAD') res.end(); else res.end(data);
  } catch (error) {
    res.statusCode=503; res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.end('DeltaScanner web build unavailable: '+(error?.message||'unknown error'));
  }
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url||'/','http://localhost');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    if (url.pathname.startsWith('/api/')) {
      const handled=await handleApi(req,res,url);
      if (!handled&&!res.writableEnded) { res.statusCode=404; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify({success:false,error:'Not found'})); }
      return;
    }
    await serveStatic(req,res,url);
  } catch { if (!res.writableEnded) { res.statusCode=500; res.end('Internal Server Error'); } }
});

const listeners = [];
function listenOn(port) {
  const instance = server.listen(port, '0.0.0.0', () => {
    console.log('[DeltaScanner Web] TESTNET UI listening on port ' + port);
  });
  listeners.push(instance);
}

listenOn(PORT);
if (PORT !== 3000) listenOn(3000);

function shutdown(signal) {
  if (shuttingDown) return; shuttingDown=true;
  console.log('[DeltaScanner Web] '+signal+' received; stopping UI and TESTNET worker safely');
  const timer=setTimeout(()=>process.exit(1),10000);
  timer.unref();
  worker.once('exit',()=>{ clearTimeout(timer); server.close(()=>process.exit(0)); });
  worker.kill('SIGTERM');
}
worker.on('exit',(code,signal)=>{
  if (!shuttingDown) {
    console.error('[DeltaScanner Web] TESTNET worker exited unexpectedly', {code,signal});
    process.exit(code ?? 1);
  }
});
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
