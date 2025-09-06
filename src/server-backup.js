// Rebuilt server.js with optimized networking and no deprecation warnings
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Buffer } from 'buffer';
import zlib from 'zlib';
import https from 'https';
import http from 'http';
import { initHistoryStore, recordHistory, getRecentHistory, getStats, getMode } from './historyStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const DEBUG = process.env.PROXY_DEBUG === '1';
const PORT = process.env.PORT || 2456;
const HOST = process.env.HOST || '0.0.0.0';
await initHistoryStore();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req,res,next)=>{ req._pxStart = process.hrtime.bigint(); next(); });

console.log('History backend mode:', getMode());

// Base64url helpers
function encodeOrigin(origin){return Buffer.from(origin,'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodeOrigin(id){try{const b64=id.replace(/-/g,'+').replace(/_/g,'/');const pad=b64.length%4===0?'':'='.repeat(4-(b64.length%4));return Buffer.from(b64+pad,'base64').toString('utf8');}catch{return null;}}

// Home route
app.get('/', (req,res)=>{
  const p = req.query.p || req.query.u || req.query.url;
  if (p){
    let t = Array.isArray(p)?p[0]:p; t=t.trim().replace(/^"|"$/g,'').replace(/^'|'$/g,'');
    if(!/^https?:\/\//i.test(t)) t='https://'+t.replace(/^\/+/,'');
    try{ const u=new URL(t); const id=encodeOrigin(u.origin); return res.redirect(302, '/go/'+id+u.pathname+u.search+u.hash);}catch{ return res.status(400).send('Bad URL'); }
  }
  res.render('index',{ recent:getRecentHistory(200), stats:getStats() });
// Fast HTTP agent configuration
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 5000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 5000,
  rejectUnauthorized: false // Allow self-signed certificates
});

// Browser interface route
app.get('/browser', (req,res)=>{
  res.render('browser', { recent:getRecentHistory(10) });
});

// Optimized proxy handler with fast networking
function handleProxy(req, res, target, { raw = false, insecure = false } = {}) {
  // Add timing measurement
  req._pxStart = process.hrtime.bigint();
  
  let url;
  try { 
    url = new URL(target); 
  } catch { 
    return res.status(400).json({ error: 'Invalid target URL' }); 
  }
  
  req.url = url.pathname + url.search + url.hash;
  if (DEBUG) console.log('[proxy][start]', target, 'req.url=', req.url, 'raw=', raw);
  
  const baseOptions = {
    target: url.origin,
    changeOrigin: true,
    logLevel: DEBUG ? 'debug' : 'silent',
    secure: !insecure,
    timeout: 3000, // Reduced timeout
    proxyTimeout: 5000, // Reduced proxy timeout
    // Use custom agents for better performance
    agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  };
  
  if (raw) return createProxyMiddleware(baseOptions)(req, res, () => {});
  
  const proxy = createProxyMiddleware({
    ...baseOptions,
    selfHandleResponse: true,
    onProxyReq: (pReq) => {
      // Set proper headers for faster loading
      pReq.setHeader('accept-encoding', 'gzip, deflate');
      if (req.headers.range) pReq.setHeader('range', req.headers.range);
      // Add cache headers
      pReq.setHeader('cache-control', 'no-cache');
      pReq.setHeader('pragma', 'no-cache');
      // Set aggressive timeout
      pReq.setTimeout(3000, () => {
        pReq.destroy();
      });
    },
    },
    onProxyRes: (pRes, rq, rs) => {
      const isHtml = /text\/html/i.test(pRes.headers['content-type'] || '');
      const enc = (pRes.headers['content-encoding'] || '').toLowerCase();
      const chunks = [];
      let ended = false;
      
      // Faster timeout for responses
      const safety = setTimeout(() => {
        if (ended) return;
        ended = true;
        try { rs.writeHead(504); } catch {}
        rs.end('Response timeout');
      }, 8000).unref(); // Reduced from 30s to 8s
      
      // Process cookies
      const sc = pRes.headers['set-cookie'];
      if (sc) pRes.headers['set-cookie'] = sc.map(c => 
        c.replace(/;\s*Domain=[^;]+/i, '')
         .replace(/;\s*Secure/gi, '')
         .replace(/;\s*SameSite=[^;]+/i, '; SameSite=Lax')
      );
      
      // Handle redirects
      const loc = pRes.headers['location'];
      if (loc) {
        try {
          const abs = loc.startsWith('/') ? url.origin + loc : loc;
          const u = new URL(abs);
          pRes.headers['location'] = '/go/' + encodeOrigin(u.origin) + u.pathname + u.search;
        } catch {}
      }
      
      pRes.on('data', d => {
        if (isHtml) chunks.push(d);
        else rs.write(d);
      });
      
      pRes.on('error', e => {
        if (ended) return;
        ended = true;
        clearTimeout(safety);
        try { rs.writeHead(502, { 'Content-Type': 'application/json' }); } catch {}
        rs.end(JSON.stringify({ error: 'Upstream error', detail: e.message }));
      });
      
      pRes.on('end', () => {
        if (ended) return;
        ended = true;
        clearTimeout(safety);
        
        const end = process.hrtime.bigint();
        const dur = req._pxStart ? Number(end - req._pxStart) / 1_000_000 : 0;
        recordHistory({
          method: req.method,
          url: target,
          target_host: url.host,
          status: pRes.statusCode,
          duration_ms: Math.round(dur),
          user_agent: req.headers['user-agent'] || '',
          ip: req.ip
        });
        
        if (!isHtml) {
          rs.end();
          return;
        }
        
        try {
          let rawBuf = Buffer.concat(chunks);
          let dec;
          if (enc === 'gzip') dec = zlib.gunzipSync(rawBuf);
          else if (enc === 'br' && zlib.brotliDecompressSync) dec = zlib.brotliDecompressSync(rawBuf);
          else if (enc === 'deflate') dec = zlib.inflateSync(rawBuf);
          else dec = rawBuf;
          
          let body = dec.toString('utf8');
          body = rewriteHtml(body, url);
          
          delete pRes.headers['content-length'];
          delete pRes.headers['content-encoding'];
          rs.writeHead(pRes.statusCode || 200, pRes.headers);
          rs.end(body);
        } catch (e) {
          rs.writeHead(pRes.statusCode || 200, pRes.headers);
          rs.end(Buffer.concat(chunks));
        }
      });
    },
    onError: (err, rq, rs) => {
      const end = process.hrtime.bigint();
      const dur = req._pxStart ? Number(end - req._pxStart) / 1_000_000 : 0;
      recordHistory({
        method: req.method,
        url: target,
        target_host: url.host,
        status: 502,
        duration_ms: Math.round(dur),
        user_agent: req.headers['user-agent'] || '',
        ip: req.ip
      });
      rs.writeHead(502, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    }
  });
  
  return proxy(req, res, () => {});
}

// Query style legacy endpoint -> redirect to path style (unless raw)
app.use('/proxy', (req,res)=>{
  const t=req.query.target; if(!t) return res.status(400).json({error:'Missing target'});
  const rawFlag=(req.query.raw||'').toString().toLowerCase(); const raw = rawFlag==='1'||rawFlag==='true';
  let u; try{ u=new URL(t);}catch{return res.status(400).json({error:'Bad target'});} if(!raw){ const id=encodeOrigin(u.origin); return res.redirect(302,'/go/'+id+u.pathname+u.search+u.hash); }
  req.url=u.pathname+u.search+u.hash; return handleProxy(req,res,t,{raw:true,insecure:req.query.insecure==='1'});
});

// Path style endpoint
app.use('/go/:oid', (req,res)=>{
  const { oid }=req.params; const origin=decodeOrigin(oid); if(!origin) return res.status(400).json({error:'Bad origin id'});
  const base='/go/'+oid; let rest=req.originalUrl.slice(base.length) || '/'; if(!rest.startsWith('/')) rest='/'+rest; const target=origin+rest; return handleProxy(req,res,target,{insecure:req.query.insecure==='1'});
});

// History API
app.get('/api/history', (req,res)=>{ const limit=Math.min(parseInt(req.query.limit||'200',10),1000); res.json(getRecentHistory(limit)); });

// Diagnostics fetch
app.get('/diag/fetch', async (req,res)=>{ const url=req.query.url; if(!url) return res.status(400).json({error:'Missing url'}); const start=Date.now(); try{ const r=await fetch(url,{method:'HEAD'}).catch(()=>fetch(url)); const sample=await r.text().then(t=>t.slice(0,120)).catch(()=>'' ); res.json({ok:r.ok,status:r.status,elapsed_ms:Date.now()-start,headers:Object.fromEntries(r.headers.entries()),sample}); }catch(e){ res.status(500).json({error:e.message, elapsed_ms:Date.now()-start}); }});

// Simple no-rewrite fetch
app.get('/p', async (req,res)=>{ const t=req.query.target; if(!t) return res.status(400).json({error:'Missing target'}); try{ const u=new URL(t); const r=await fetch(u,{headers:{'user-agent':req.headers['user-agent']||'diag'}}); res.status(r.status); r.headers.forEach((v,k)=>{ if(!['content-length','content-encoding'].includes(k)) res.setHeader(k,v); }); const buf=Buffer.from(await r.arrayBuffer()); res.send(buf);}catch(e){ res.status(502).json({error:'Fetch failed', detail:e.message}); } });

// --- HTML Rewriting ---
function shouldRewrite(u){ if(!u) return false; if(u.startsWith('#')) return false; if(u.startsWith('data:')) return false; if(u.startsWith('javascript:')) return false; if(u.startsWith('/go/')) return false; return true; }
function rewriteHtml(html, baseUrl){
  const baseOrigin=baseUrl.origin; const baseId=encodeOrigin(baseOrigin);
  const prefix='/go/';
  const toolbarStyles=`<style id="__px_toolbar_css">#__px_toolbar{position:fixed;top:0;left:0;right:0;height:42px;z-index:2147483647;display:flex;gap:6px;align-items:center;padding:6px 10px;background:#111;color:#eee;font:14px system-ui,sans-serif;border-bottom:1px solid #333;box-sizing:border-box}#__px_toolbar button{background:#222;border:1px solid #444;color:#ddd;padding:4px 10px;border-radius:4px;cursor:pointer;font:12px system-ui,sans-serif;display:flex;align-items:center;gap:4px}#__px_toolbar button:hover{background:#2e2e2e}#__px_toolbar input{flex:1;min-width:120px;background:#181818;border:1px solid #333;color:#eee;padding:6px 8px;border-radius:4px;font:13px system-ui,sans-serif}#__px_toolbar input:focus{outline:1px solid #555}#__px_toolbar .__px_logo{font-weight:600;letter-spacing:.5px}#__px_toolbar_space{height:42px}</style>`;
  const toolbarHtml=`<div id="__px_toolbar"><span class="__px_logo">PX</span><button id="__px_back" title="Back">←</button><button id="__px_fwd" title="Forward">→</button><button id="__px_reload" title="Reload">⟳</button><button id="__px_home" title="Home">⌂</button><input id="__px_addr" type="text" autocomplete="off" spellcheck="false" /><button id="__px_go">Go</button></div><div id="__px_toolbar_space"></div>`;
  const baseScript=`<script>window.__PX_BASE_ORIGIN='${baseOrigin.replace(/'/g,"\\'")}';window.__PX_BASE_ID='${baseId}';window.__PX_PREFIX='${prefix}';</script>`;
  html=html.replace(/<body[^>]*>/i,m=>m+toolbarHtml).replace(/<head[^>]*>/i,m=>m+toolbarStyles);
  html=html.replace(/\b(href|src|action)=("|')(.*?)(\2)/gi,(m,attr,q,val)=>{ if(!shouldRewrite(val)) return m; try{ const abs=new URL(val.startsWith('//')?baseUrl.protocol+val:val, baseUrl); const oid=encodeOrigin(abs.origin); const path=abs.pathname+abs.search+abs.hash; return `${attr}=${q}${prefix}${oid}${path}${q}`; }catch{return m;} });
  html=html.replace(/<meta[^>]*http-equiv=("|')refresh\1[^>]*>/gi, tag=> tag.replace(/content=("')(\d+\s*;\s*url=)([^"']+)("')/i,(m2,q,prefix2,urlv)=>{ if(!shouldRewrite(urlv)) return m2; try{ const abs=new URL(urlv, baseUrl); const oid=encodeOrigin(abs.origin); return `content=${q}${prefix2}${prefix}${oid}${abs.pathname+abs.search+abs.hash}${q}`; }catch{return m2;} }));
  const inject=`<script>(function(){if(window.__PX_INJECTED)return;window.__PX_INJECTED=1;const BASE=window.__PX_BASE_ORIGIN;const PFX=window.__PX_PREFIX;function b64(s){return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}function prox(u){try{const A=new URL(u.startsWith('http')?u:'//'+u, A?A:window.location.href);return PFX+b64(A.origin)+A.pathname+A.search+A.hash}catch(e){try{const B=new URL(u, BASE);return PFX+b64(B.origin)+B.pathname+B.search+B.hash}catch{return u}}}function cleanDisplay(u){try{const x=new URL(u.startsWith(PFX)?u.replace(PFX,'https://'):u,window.location.href);return x.href}catch{return u}}const addr=document.getElementById('__px_addr');const back=document.getElementById('__px_back');const fwd=document.getElementById('__px_fwd');const reload=document.getElementById('__px_reload');const home=document.getElementById('__px_home');const go=document.getElementById('__px_go');function updateBar(){if(!addr)return;addr.value=window.__PX_CURRENT_DISPLAY||window.location.href;}updateBar();back.onclick=()=>history.back();fwd.onclick=()=>history.forward();reload.onclick=()=>location.reload();home.onclick=()=>{window.location.href='/';};function navigate(raw){if(!raw)return;let u=raw.trim();if(!/^https?:\/\//i.test(u)) u='https://'+u; try{const U=new URL(u);window.location.href=PFX+b64(U.origin)+U.pathname+U.search+U.hash;}catch{}}addr.addEventListener('keydown',e=>{if(e.key==='Enter') navigate(addr.value);});go.onclick=()=>navigate(addr.value);const origPush=history.pushState, origReplace=history.replaceState;function wrap(fn){return function(s,t,u){if(u){window.__PX_CURRENT_DISPLAY=u;/* show raw for user */}return fn.call(this,s,t,u)}}history.pushState=wrap(origPush);history.replaceState=wrap(origReplace);document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href]');if(!a)return;let h=a.getAttribute('href');if(!h)return;if(h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('data:'))return; if(h.startsWith(PFX)){window.__PX_CURRENT_DISPLAY=h;return;}e.preventDefault();navigate(h);},true);})();</script>`;
  if (/<head[^>]*>/i.test(html)) html=html.replace(/<head[^>]*>/i,m=>m+baseScript+inject); else if (/<\/head>/i.test(html)) html=html.replace(/<\/head>/i,baseScript+inject+'</head>'); else html=baseScript+inject+html; return html;
}

// Test route for debugging
app.get('/test', async (req, res) => {
  try {
    const testFetch = await fetch('https://httpbin.org/get', { timeout: 5000 });
    const testData = await testFetch.text();
    res.json({
      status: 'proxy server working',
      time: new Date().toISOString(),
      mode: getMode(),
      debug: DEBUG,
      port: PORT,
      networkTest: {
        success: testFetch.ok,
        status: testFetch.status,
        preview: testData.slice(0, 100)
      }
    });
  } catch (error) {
    res.json({
      status: 'proxy server working but network test failed',
      time: new Date().toISOString(),
      mode: getMode(),
      debug: DEBUG,
      port: PORT,
      networkError: error.message
    });
  }
});

// Demo route to show working proxy with a simple site
app.get('/demo', (req, res) => {
  res.redirect('/browser?demo=httpbin.org/html');
});

app.get('/healthz',(req,res)=>res.json({status:'ok', time:new Date().toISOString()}));

const server = app.listen(PORT,HOST,()=>{ console.log(`Proxy server listening on http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`); });
// Increase max listeners to prevent memory leak warnings
server.setMaxListeners(20);
