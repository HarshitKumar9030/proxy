import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, '..', 'proxy.db');
const JSON_FILE = path.join(__dirname, '..', 'history.json');

let mode = 'memory';
let db = null;
let insertStmt, recentStmt, statsStmt;
let mem = [];
let dirty = false;

function persistMemory() {
  if (mode !== 'memory' || !dirty) return;
  try {
    fs.writeFileSync(JSON_FILE, JSON.stringify(mem.slice(-5000))); // keep last 5k
    dirty = false;
  } catch (e) {
    console.error('Failed to persist memory history:', e.message);
  }
}

export async function initHistoryStore() {
  // Try better-sqlite3 first
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    db = new Database(DB_FILE);
    db.exec(`CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      target_host TEXT NOT NULL,
      status INTEGER,
      duration_ms INTEGER,
      user_agent TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    insertStmt = db.prepare(`INSERT INTO history (id, method, url, target_host, status, duration_ms, user_agent, ip) VALUES (@id, @method, @url, @target_host, @status, @duration_ms, @user_agent, @ip)`);
    recentStmt = db.prepare(`SELECT * FROM history ORDER BY created_at DESC LIMIT ?`);
    statsStmt = db.prepare(`SELECT COUNT(*) as total, COUNT(DISTINCT target_host) as distinct_hosts, AVG(duration_ms) as avg_duration FROM history`);
    mode = 'sqlite';
    console.log('[historyStore] Using better-sqlite3 backend');
  } catch (e) {
    mode = 'memory';
    console.warn('[historyStore] Falling back to in-memory history (better-sqlite3 load failed):', e.message);
    // Load existing JSON if present
    try {
      if (fs.existsSync(JSON_FILE)) {
        mem = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
      }
    } catch (e2) {
      console.warn('[historyStore] Could not load existing history.json:', e2.message);
    }
    setInterval(persistMemory, 10_000).unref();
    process.on('exit', persistMemory);
  }
}

export function recordHistory({ method, url, target_host, status, duration_ms, user_agent, ip }) {
  const id = nanoid(12);
  if (mode === 'sqlite') {
    try {
      insertStmt.run({ id, method, url, target_host, status, duration_ms, user_agent, ip });
    } catch (e) {
      console.error('History insert failed:', e.message);
    }
  } else {
    mem.push({ id, method, url, target_host, status, duration_ms, user_agent, ip, created_at: new Date().toISOString() });
    dirty = true;
  }
}

export function getRecentHistory(limit = 200) {
  if (mode === 'sqlite') {
    return recentStmt.all(limit);
  }
  return mem.slice(-limit).reverse();
}

export function getStats() {
  if (mode === 'sqlite') {
    return statsStmt.get();
  }
  const total = mem.length;
  const hosts = new Set(mem.map(r => r.target_host));
  const avg = mem.length ? mem.reduce((a, r) => a + (r.duration_ms || 0), 0) / mem.length : 0;
  return { total, distinct_hosts: hosts.size, avg_duration: avg };
}

export function getMode() { return mode; }
