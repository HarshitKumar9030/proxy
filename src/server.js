import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Buffer } from 'buffer';
import { initHistoryStore, recordHistory, getRecentHistory, getStats, getMode } from './historyStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Default port changed to 2456 (can override via PORT env var)
const PORT = process.env.PORT || 2456;
// Allow binding host override (bind to 127.0.0.1 behind nginx; default 0.0.0.0)
const HOST = process.env.HOST || '0.0.0.0';
await initHistoryStore();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Middleware to capture start time
app.use((req, res, next) => {
  req._startAt = process.hrtime.bigint();
  next();
});

console.log('History backend mode:', getMode());

// Home UI
app.get('/', (req, res) => {
  const recent = getRecentHistory(200);
  const stats = getStats();
  res.render('index', { recent, stats });
});

// API to fetch history JSON
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const rows = getRecentHistory(limit);
  res.json(rows);
});

// Proxy route - using query parameter target
// Usage: /proxy?target=https://example.com/path
app.use('/proxy', async (req, res, next) => {
  const target = req.query.target;
  if (!target) {
    return res.status(400).json({ error: 'Missing target query param' });
  }
  try {
    const targetUrl = new URL(target);
    // Rewrite the incoming request URL so upstream does NOT see ?target=...
    req.url = targetUrl.pathname + (targetUrl.search || '');

    const proxy = createProxyMiddleware({
      target: targetUrl.origin,
      changeOrigin: true,
      selfHandleResponse: true, // We'll optionally modify HTML
      logLevel: 'warn',
      onProxyRes: (proxyRes, req2, res2) => {
        const chunks = [];
        const isHtml = /text\/html/i.test(proxyRes.headers['content-type'] || '');
        // Rewrite redirect Location headers to remain proxied
        const loc = proxyRes.headers['location'];
        if (loc && (loc.startsWith('http://') || loc.startsWith('https://') || loc.startsWith('/'))) {
          try {
            let absolute;
            if (loc.startsWith('/')) absolute = targetUrl.origin + loc; else absolute = loc;
            proxyRes.headers['location'] = '/proxy?target=' + encodeURIComponent(absolute);
          } catch (_) {}
        }

        proxyRes.on('data', d => {
          if (isHtml) chunks.push(d); else res2.write(d);
        });
        proxyRes.on('end', () => {
          const end = process.hrtime.bigint();
          const durationMs = Number(end - req._startAt) / 1_000_000;
          recordHistory({
            method: req.method,
            url: target,
            target_host: targetUrl.host,
            status: proxyRes.statusCode,
            duration_ms: Math.round(durationMs),
            user_agent: req.headers['user-agent'] || '',
            ip: req.ip
          });

          if (!isHtml) {
            return res2.end();
          }
          try {
            let body = Buffer.concat(chunks).toString('utf8');
            body = rewriteHtml(body, targetUrl);
            // Remove content-length (changed)
            delete proxyRes.headers['content-length'];
            res2.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            res2.end(body);
          } catch (e) {
            res2.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            res2.end(Buffer.concat(chunks));
          }
        });
      },
      onError: (err, req2, res2) => {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - req._startAt) / 1_000_000;
        recordHistory({
          method: req.method,
          url: target,
          target_host: targetUrl.host,
          status: 502,
          duration_ms: Math.round(durationMs),
          user_agent: req.headers['user-agent'] || '',
          ip: req.ip
        });
        res2.writeHead(502, { 'Content-Type': 'application/json' });
        res2.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
      }
    });
    return proxy(req, res, next);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }
});

// ---- HTML Rewriting Helpers ----
function absolutize(urlVal, base) {
  try { return new URL(urlVal, base).href; } catch { return urlVal; }
}
function shouldRewrite(u) {
  if (!u) return false;
  if (u.startsWith('#')) return false;
  if (u.startsWith('data:')) return false;
  if (u.startsWith('javascript:')) return false;
  if (u.startsWith('/proxy?target=')) return false;
  return true;
}
function proxify(u) { return '/proxy?target=' + encodeURIComponent(u); }
function rewriteHtml(html, baseUrl) {
  // Attributes: href, src, action
  html = html.replace(/\b(href|src|action)=("|')(.*?)(\2)/gi, (m, attr, q, val) => {
    if (!shouldRewrite(val)) return m;
    const abs = absolutize(val, baseUrl);
    return `${attr}=${q}${proxify(abs)}${q}`;
  });
  // Meta refresh
  html = html.replace(/<meta[^>]*http-equiv=("|')refresh\1[^>]*>/gi, tag => {
    return tag.replace(/content=("|')(\d+\s*;\s*url=)([^"']+)("|')/i, (m2, q, prefix, urlv, q2) => {
      if (!shouldRewrite(urlv)) return m2;
      const abs = absolutize(urlv, baseUrl);
      return `content=${q}${prefix}${proxify(abs)}${q}`;
    });
  });
  // Inject client-side interception script before </head>
  const inject = `<script>(function(){if(window.__PX_INJECTED)return;window.__PX_INJECTED=1;const P='/proxy?target=';const abs=u=>{try{return new URL(u,location.href).href}catch(_){return u}};const prox=u=>P+encodeURIComponent(abs(u));['pushState','replaceState'].forEach(fn=>{const o=history[fn];history[fn]=function(s,t,u){if(u&&u.indexOf(P)!==0)u=prox(u);return o.call(this,s,t,u)}});const la=location.assign.bind(location);location.assign=function(u){la(prox(u))};const lr=location.replace.bind(location);location.replace=function(u){lr(prox(u))};document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a)return;if(a.target&&a.target!=='_self')return;const h=a.getAttribute('href');if(!h||h.startsWith('#')||h.startsWith('javascript:'))return;if(h.startsWith(P))return;e.preventDefault();location.assign(h);});})();</script>`;
  if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, inject + '</head>'); else html = inject + html;
  return html;
}

// Simple health endpoint
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, HOST, () => {
  console.log(`Proxy server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
