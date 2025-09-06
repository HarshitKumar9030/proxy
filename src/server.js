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
  crossOriginEmbedderPolicy: false,
  frameguard: false  // Disable X-Frame-Options to avoid conflicts with proxied content
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

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mode: getMode()
  });
});

// Fast proxy handler with optimized networking
function handleProxy(req, res, target, { raw = false, insecure = false } = {}) {
  const startTime = process.hrtime.bigint();
  
  let url;
  try {
    url = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL' });
  }
  
  req.url = url.pathname + url.search + url.hash;
  if (DEBUG) console.log('[proxy][start]', target, 'req.url=', req.url, 'raw=', raw);
  
  // Use native HTTP/HTTPS for more control
  if (raw) {
    // For raw mode, use simple proxy middleware
    const simpleProxy = createProxyMiddleware({
      target: url.origin,
      changeOrigin: true,
      logLevel: 'silent',
      secure: !insecure,
      timeout: 10000,
      agent: url.protocol === 'https:' ? httpsAgent : httpAgent
    });
    return simpleProxy(req, res, () => {});
  }
  
  // For HTML rewriting, use custom implementation
  const protocol = url.protocol === 'https:' ? https : http;
  const agent = url.protocol === 'https:' ? httpsAgent : httpAgent;
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: {
      ...req.headers,
      'Host': url.host,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    agent: agent,
    timeout: 10000
  };
  
  // Remove hop-by-hop headers
  delete options.headers['connection'];
  delete options.headers['upgrade'];
  delete options.headers['proxy-authorization'];
  delete options.headers['proxy-authenticate'];
  delete options.headers['te'];
  delete options.headers['trailers'];
  delete options.headers['transfer-encoding'];
  
  const proxyReq = protocol.request(options, (proxyRes) => {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1_000_000;
    
    // Record to history
    recordHistory({
      method: req.method,
      url: target,
      target_host: url.host,
      status: proxyRes.statusCode,
      duration_ms: Math.round(duration),
      user_agent: req.headers['user-agent'] || '',
      ip: req.ip
    });
    
    const headers = { ...proxyRes.headers };
    const contentType = headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    
    // Handle cookies
    if (headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(cookie => 
        cookie.replace(/;\s*Domain=[^;]+/i, '')
              .replace(/;\s*Secure/gi, '')
              .replace(/;\s*SameSite=[^;]+/i, '; SameSite=Lax')
      );
    }
    
    // Remove problematic headers that can cause conflicts
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    
    // Handle redirects
    if (headers.location) {
      try {
        const redirectUrl = new URL(headers.location, url.origin);
        headers.location = `/go/${encodeOrigin(redirectUrl.origin)}${redirectUrl.pathname}${redirectUrl.search}`;
      } catch (e) {
        console.log('Redirect URL parsing failed:', e.message);
      }
    }
    
    // For non-HTML, stream directly
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // For HTML, collect and rewrite
    const chunks = [];
    
    proxyRes.on('data', chunk => {
      chunks.push(chunk);
    });
    
    proxyRes.on('end', () => {
      try {
        let body = Buffer.concat(chunks);
        
        // Handle compression
        const encoding = headers['content-encoding'];
        if (encoding === 'gzip') {
          body = zlib.gunzipSync(body);
        } else if (encoding === 'deflate') {
          body = zlib.inflateSync(body);
        } else if (encoding === 'br' && zlib.brotliDecompressSync) {
          body = zlib.brotliDecompressSync(body);
        }
        
        // Rewrite HTML
        let html = body.toString('utf8');
        html = rewriteHtml(html, url);
        
        // Send response
        delete headers['content-length'];
        delete headers['content-encoding'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(html);
        
      } catch (error) {
        console.error('HTML processing error:', error.message);
        // Send raw response on error
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(Buffer.concat(chunks));
      }
    });
    
    proxyRes.on('error', (error) => {
      console.error('Proxy response error:', error.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy Response Error');
      }
    });
  });
  
  proxyReq.on('error', (error) => {
    console.error('Proxy request error:', error.message);
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1_000_000;
    
    recordHistory({
      method: req.method,
      url: target,
      target_host: url.host,
      status: 502,
      duration_ms: Math.round(duration),
      user_agent: req.headers['user-agent'] || '',
      ip: req.ip
    });
    
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy connection error', detail: error.message }));
    }
  });
  
  proxyReq.on('timeout', () => {
    console.error('Proxy request timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Request Timeout');
    }
  });
  
  // Pipe request body if present
  if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
    proxyReq.write(JSON.stringify(req.body));
  }
  
  proxyReq.end();
}

// Handle YouTube API endpoints and other relative requests
app.use('/youtubei/*', (req, res) => {
  const referer = req.headers.referer || '';
  
  // If coming from a proxied YouTube page, proxy to YouTube
  if (referer.includes('localhost:2456/go/') && referer.includes('youtube')) {
    const target = 'https://www.youtube.com' + req.originalUrl;
    handleProxy(req, res, target, { raw: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Handle other common API paths
app.use('/generate_204', (req, res) => {
  const referer = req.headers.referer || '';
  
  if (referer.includes('localhost:2456/go/') && referer.includes('youtube')) {
    const target = 'https://www.youtube.com' + req.originalUrl;
    handleProxy(req, res, target, { raw: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Handle static assets (CSS, JS, fonts, etc.) with proper MIME types
app.use('/s/*', (req, res) => {
  const referer = req.headers.referer || '';
  
  if (referer.includes('localhost:2456/go/') && referer.includes('youtube')) {
    const target = 'https://www.youtube.com' + req.originalUrl;
    handleProxy(req, res, target, { raw: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Handle fonts.googleapis.com requests
app.use('/fonts.googleapis.com/*', (req, res) => {
  const target = 'https://fonts.googleapis.com' + req.originalUrl.replace('/fonts.googleapis.com', '');
  handleProxy(req, res, target, { raw: true });
});

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
  
  // Check for double-encoded URLs and clean them up
  if (rest.includes('/go/') && rest.includes('aHR0cHM6Ly8')) {
    // This is a double-encoded URL, extract the inner part
    const innerMatch = rest.match(/\/go\/[^\/]+(.+)/);
    if (innerMatch) {
      rest = innerMatch[1];
    }
  }
  
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

// Minimal HTML rewriting for better compatibility with large sites
function rewriteHtml(body, url) {
  try {
    const originId = encodeOrigin(url.origin);
    
    // Simple and aggressive URL rewriting - minimal approach for big sites
    body = body
      // Fix absolute URLs in href/src/action attributes (skip if already proxied)
      .replace(/\b(href|src|action)\s*=\s*["']https?:\/\/([^"']+)["']/gi, (match, attr, fullUrl) => {
        // Skip if URL is already proxied or contains proxy patterns
        if (fullUrl.includes('/go/') || fullUrl.includes('aHR0cHM6Ly8') || fullUrl.includes('localhost:2456')) {
          return match;
        }
        try {
          const parsedUrl = new URL(fullUrl);
          return `${attr}="/go/${encodeOrigin(parsedUrl.origin)}${parsedUrl.pathname}${parsedUrl.search}"`;
        } catch {
          return match; // Keep original if parsing fails
        }
      })
      // Fix relative URLs starting with / (skip if already proxied)
      .replace(/\b(href|src|action)\s*=\s*["']\/([^"']*?)["']/gi, (match, attr, path) => {
        // Skip if path is already proxied or contains proxy patterns
        if (path.startsWith('go/') || path.includes('aHR0cHM6Ly8') || path.includes('localhost:2456')) {
          return match;
        }
        return `${attr}="/go/${originId}/${path}"`;
      })
      // Fix protocol-relative URLs (skip if already proxied)
      .replace(/\b(href|src|action)\s*=\s*["']\/\/([^"']+)["']/gi, (match, attr, relUrl) => {
        // Skip if URL is already proxied or contains proxy patterns
        if (relUrl.includes('/go/') || relUrl.includes('aHR0cHM6Ly8') || relUrl.includes('localhost:2456')) {
          return match;
        }
        try {
          const parsedUrl = new URL(`https://${relUrl}`);
          return `${attr}="/go/${encodeOrigin(parsedUrl.origin)}${parsedUrl.pathname}${parsedUrl.search}"`;
        } catch {
          return match;
        }
      });

    // Add minimal toolbar only if this is a full HTML page
    if (body.includes('<head>') && body.includes('<body>')) {
      const toolbar = `
<div id="proxy-toolbar" style="position: fixed; top: 0; left: 0; right: 0; background: #1a1a1a; color: white; padding: 8px 16px; font-family: system-ui; font-size: 14px; z-index: 999999; border-bottom: 1px solid #333;">
  <span>🌐 ${url.hostname}${url.pathname !== '/' ? url.pathname : ''}</span>
  <a href="/browser" style="float: right; background: #0066cc; color: white; padding: 4px 12px; border-radius: 4px; text-decoration: none;">New Tab</a>
</div>
<style>body { margin-top: 40px !important; }</style>`;
      
      body = body.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);
    }

    return body;
  } catch (error) {
    console.error('HTML rewrite error:', error.message);
    return body; // Return original on any error
  }
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
