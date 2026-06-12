/**
 * Request Logger
 * Persists entries to data/logs.jsonl (one JSON per line).
 * In-memory index holds up to maxEntries for fast queries.
 * Supports date-range filtering for the dashboard.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const LOGS_FILE   = path.join(DATA_DIR, 'logs.jsonl');
const STATS_FILE  = path.join(DATA_DIR, 'token_stats.json');
const MAX_FILE_DAYS = 30; // purge entries older than this on startup

class RequestLogger {
  constructor(maxEntries = 10000) {
    this.maxEntries = maxEntries;
    this.entries = [];       // newest first
    this._ws = null;         // write stream
    this._tokenStats = { totalTokens: 0, totalPrompt: 0, totalCompletion: 0, totalRequests: 0, models: {} };
    this._statsDirty = false;
    this._statsFlushTimer = null;

    this._ensureDir();
    this._loadFromDisk();
    this._loadTokenStats();
    this._openStream();
  }

  // ── Internal ──────────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _loadFromDisk() {
    if (!fs.existsSync(LOGS_FILE)) return;
    try {
      const cutoff = Date.now() - MAX_FILE_DAYS * 86400_000;
      const lines  = fs.readFileSync(LOGS_FILE, 'utf8').split('\n').filter(Boolean);
      const loaded = [];
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (new Date(e.timestamp).getTime() >= cutoff) loaded.push(e);
        } catch { /* skip bad line */ }
      }
      // newest first; cap at maxEntries
      loaded.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      this.entries = loaded.slice(0, this.maxEntries);
      console.log(`[Logger] Loaded ${this.entries.length} log entries from disk`);

      // Rewrite file without old entries (compaction)
      const kept = [...this.entries].reverse(); // oldest first for file
      fs.writeFileSync(LOGS_FILE, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch (err) {
      console.warn('[Logger] Failed to load logs from disk:', err.message);
    }
  }

  _loadTokenStats() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        this._tokenStats = {
          totalTokens:     raw.totalTokens     || 0,
          totalPrompt:     raw.totalPrompt     || 0,
          totalCompletion: raw.totalCompletion || 0,
          totalRequests:   raw.totalRequests   || 0,
          models:          raw.models          || {},
        };
        console.log(`[Logger] Token stats loaded — ${this._tokenStats.totalTokens.toLocaleString()} total tokens across ${this._tokenStats.totalRequests.toLocaleString()} requests`);
      }
    } catch (err) {
      console.warn('[Logger] Could not load token stats:', err.message);
    }
  }

  _flushTokenStats() {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this._tokenStats), 'utf8');
      this._statsDirty = false;
    } catch (err) {
      console.warn('[Logger] Could not save token stats:', err.message);
    }
  }

  _scheduleStatsFlush() {
    if (this._statsFlushTimer) return;
    this._statsFlushTimer = setTimeout(() => {
      this._statsFlushTimer = null;
      if (this._statsDirty) this._flushTokenStats();
    }, 5000); // batch writes — flush at most every 5s
  }

  _openStream() {
    try {
      this._ws = fs.createWriteStream(LOGS_FILE, { flags: 'a', encoding: 'utf8' });
      this._ws.on('error', err => console.warn('[Logger] Write stream error:', err.message));
    } catch (err) {
      console.warn('[Logger] Could not open log stream:', err.message);
    }
  }

  // ── Public API ────────────────────────────────────────────────

  log({ method, path: reqPath, keyHint, urlHint, status, responseTime, error, payload, model, ip, userAgent, tokens }) {
    const entry = {
      timestamp:    new Date().toISOString(),
      method,
      path:         reqPath,
      keyHint,
      urlHint:      urlHint      || null,
      status,
      responseTime,
      error:        error        || null,
      payload:      payload      || null,
      model:        model        || null,
      ip:           ip           || null,
      userAgent:    userAgent    || null,
      tokens:       tokens       || null,
    };

    // In-memory: newest first
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.pop();

    // Persist log line
    if (this._ws) {
      this._ws.write(JSON.stringify(entry) + '\n');
    }

    // Accumulate all-time global + per-model token stats
    this._tokenStats.totalRequests++;
    if (tokens) {
      this._tokenStats.totalTokens     += tokens.total      || 0;
      this._tokenStats.totalPrompt     += tokens.prompt     || 0;
      this._tokenStats.totalCompletion += tokens.completion || 0;
    }
    if (model) {
      if (!this._tokenStats.models[model]) {
        this._tokenStats.models[model] = { totalTokens: 0, totalPrompt: 0, totalCompletion: 0, totalRequests: 0 };
      }
      const ms = this._tokenStats.models[model];
      ms.totalRequests++;
      if (tokens) {
        ms.totalTokens     += tokens.total      || 0;
        ms.totalPrompt     += tokens.prompt     || 0;
        ms.totalCompletion += tokens.completion || 0;
      }
    }
    this._statsDirty = true;
    this._scheduleStatsFlush();
  }

  getTokenStats() {
    return this._tokenStats;
  }

  /**
   * Return entries optionally filtered by date range.
   * @param {string|null} from  ISO date string (inclusive)
   * @param {string|null} to    ISO date string (inclusive, end of that day)
   */
  getAll(from = null, to = null) {
    if (!from && !to) return this.entries;
    const fromMs = from ? new Date(from).getTime()             : 0;
    const toMs   = to   ? new Date(to).getTime() + 86400_000   : Infinity; // include full "to" day
    return this.entries.filter(e => {
      const t = new Date(e.timestamp).getTime();
      return t >= fromMs && t < toMs;
    });
  }

  clear() {
    this.entries = [];
    if (this._ws) {
      this._ws.end();
      this._ws = null;
    }
    try { fs.writeFileSync(LOGS_FILE, '', 'utf8'); } catch { /* ignore */ }
    this._openStream();
  }
}

module.exports = RequestLogger;
