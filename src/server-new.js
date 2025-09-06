// Optimized proxy server with fast networking and no deprecation warnings
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

const PORT = parseInt(process.env.PORT || '2456', 10);
const DEBUG = process.env.PROXY_DEBUG === '1';

// Fast HTTP agent configuration for better performance
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 3000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 3000,
  rejectUnauthorized: false
});

// Initialize history backend
initHistoryStore();

const app = express();

// Trust proxy for proper IP handling
app.set('trust proxy', 1);

// Security and performance middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan('tiny'));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Base64URL encoding utilities
function encodeOrigin(origin) {
  return Buffer.from(origin, 'utf8').toString('base64url');
}

function decodeOrigin(base64UrlId) {
  try {
    return Buffer.from(base64UrlId, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// Home page
app.get('/', (req, res) => {
  res.render('index', { recent: getRecentHistory(5) });
});

// Browser interface route
app.get('/browser', (req, res) => {
  res.render('browser', { recent: getRecentHistory(10) });
});

// Fast proxy handler with optimized networking
function handleProxy(req, res, target, { raw = false, insecure = false } = {}) {
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
    logLevel: 'silent', // Suppress all proxy logs
    secure: !insecure,
    timeout: 2000, // Very fast timeout
    proxyTimeout: 4000,
    agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive'
    }
  };
  
  if (raw) {
    return createProxyMiddleware(baseOptions)(req, res, () => {});
  }
  
  const proxy = createProxyMiddleware({
    ...baseOptions,
    selfHandleResponse: true,
    onProxyReq: (pReq) => {
      pReq.setHeader('accept-encoding', 'gzip, deflate');
      if (req.headers.range) pReq.setHeader('range', req.headers.range);
      pReq.setTimeout(2000, () => pReq.destroy());
    },
    onProxyRes: (pRes, pReq, res) => {
      const isHtml = /text\/html/i.test(pRes.headers['content-type'] || '');
      const enc = (pRes.headers['content-encoding'] || '').toLowerCase();
      const chunks = [];
      let ended = false;
      
      const safety = setTimeout(() => {
        if (ended) return;
        ended = true;
        try { res.writeHead(504); } catch {}
        res.end('Response timeout');
      }, 5000);
      
      // Process cookies
      const sc = pRes.headers['set-cookie'];
      if (sc) {
        pRes.headers['set-cookie'] = sc.map(c => 
          c.replace(/;\s*Domain=[^;]+/i, '')
           .replace(/;\s*Secure/gi, '')
           .replace(/;\s*SameSite=[^;]+/i, '; SameSite=Lax')
        );
      }
      
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
        else res.write(d);
      });
      
      pRes.on('error', e => {
        if (ended) return;
        ended = true;
        clearTimeout(safety);
        try { res.writeHead(502, { 'Content-Type': 'application/json' }); } catch {}
        res.end(JSON.stringify({ error: 'Upstream error', detail: e.message }));
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
          res.end();
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
          res.writeHead(pRes.statusCode || 200, pRes.headers);
          res.end(body);
        } catch (e) {
          res.writeHead(pRes.statusCode || 200, pRes.headers);
          res.end(Buffer.concat(chunks));
        }
      });
    },
    onError: (err, pReq, res) => {
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
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    }
  });
  
  return proxy(req, res, () => {});
}

// Legacy proxy endpoint
app.use('/proxy', (req, res) => {
  const t = req.query.target;
  if (!t) return res.status(400).json({ error: 'Missing target' });
  
  const rawFlag = (req.query.raw || '').toString().toLowerCase();
  const raw = rawFlag === '1' || rawFlag === 'true';
  
  let u;
  try {
    u = new URL(t);
  } catch {
    return res.status(400).json({ error: 'Bad target' });
  }
  
  if (!raw) {
    const id = encodeOrigin(u.origin);
    return res.redirect(302, '/go/' + id + u.pathname + u.search + u.hash);
  }
  
  req.url = u.pathname + u.search + u.hash;
  return handleProxy(req, res, t, { raw: true, insecure: req.query.insecure === '1' });
});

// Path style endpoint
app.use('/go/:oid', (req, res) => {
  const { oid } = req.params;
  const origin = decodeOrigin(oid);
  if (!origin) return res.status(400).json({ error: 'Bad origin id' });
  
  const base = '/go/' + oid;
  let rest = req.originalUrl.slice(base.length) || '/';
  if (!rest.startsWith('/')) rest = '/' + rest;
  
  const target = origin + rest;
  return handleProxy(req, res, target, { insecure: req.query.insecure === '1' });
});

// Test endpoint for quick networking tests
app.get('/test', async (req, res) => {
  try {
    const testFetch = await fetch('https://httpbin.org/json', { 
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
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

// Demo route
app.get('/demo', (req, res) => {
  res.redirect('/browser?demo=httpbin.org/html');
});

// History API
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  res.json(getRecentHistory(limit));
});

// HTML Rewriting function
function rewriteHtml(body, url) {
  const baseUrl = '/go/' + encodeOrigin(url.origin);
  
  // Add browser toolbar
  const toolbar = `
    <div id="proxy-browser-toolbar" style="position: fixed; top: 0; left: 0; right: 0; z-index: 999999; background: #f1f3f4; border-bottom: 1px solid #dadce0; padding: 8px 16px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 14px; height: 48px; box-sizing: border-box;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <button onclick="window.history.back()" style="padding: 6px 12px; border: 1px solid #dadce0; background: white; border-radius: 4px; cursor: pointer;">← Back</button>
        <button onclick="window.location.reload()" style="padding: 6px 12px; border: 1px solid #dadce0; background: white; border-radius: 4px; cursor: pointer;">↻</button>
        <div style="flex: 1; display: flex; align-items: center;">
          <span style="margin-right: 8px; color: #5f6368;">🌐</span>
          <span style="font-weight: 500; color: #202124;">${url.hostname}</span>
          <span style="color: #5f6368; margin-left: 8px;">${url.pathname}</span>
        </div>
        <a href="/browser" style="padding: 6px 12px; border: 1px solid #1a73e8; background: #1a73e8; color: white; text-decoration: none; border-radius: 4px; font-size: 12px;">New Tab</a>
      </div>
    </div>
    <div style="height: 48px;"></div>
  `;
  
  // Rewrite URLs in various attributes
  body = body.replace(/(\s(?:href|src|action)=["']?)(?:https?:)?\/\//gi, (match, prefix) => {
    return prefix + baseUrl + '/';
  });
  
  // Rewrite relative URLs
  body = body.replace(/(\s(?:href|src|action)=["']?)(?!(?:https?:|\/\/|data:|mailto:|tel:|#|javascript:))/gi, (match, prefix) => {
    return prefix + baseUrl;
  });
  
  // Insert toolbar after body tag
  body = body.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);
  
  return body;
}

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT}`);
});

// Optimize server settings
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.maxHeadersCount = 100;
server.setMaxListeners(20);

export default app;
