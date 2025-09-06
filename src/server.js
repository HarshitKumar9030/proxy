import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
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
    const proxy = createProxyMiddleware({
      target: targetUrl.origin,
      changeOrigin: true,
      selfHandleResponse: false,
      pathRewrite: {
        '^/proxy': targetUrl.pathname + (targetUrl.search || '')
      },
      logLevel: 'warn',
      onProxyRes: (proxyRes, req2, res2) => {
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

// Simple health endpoint
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, HOST, () => {
  console.log(`Proxy server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
