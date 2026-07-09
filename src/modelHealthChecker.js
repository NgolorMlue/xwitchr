'use strict';

/**
 * Model Health Checker
 *
 * Pings every configured model every 4 hours (or on-demand) with a minimal
 * 1-token request and classifies its response:
 *   - alive  : HTTP 200 within 3 000 ms
 *   - slow   : HTTP 200 but took > 3 000 ms
 *   - dead   : non-200, timeout, or network error
 *
 * Results are persisted to data/model_health.json and survive restarts.
 * Checks run with a concurrency limit of 5 to avoid hammering providers.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const HEALTH_FILE = path.join(DATA_DIR, 'model_health.json');

const SLOW_THRESHOLD_MS = 5_000;  // > 5s = slow, ≤ 5s = alive
const CHECK_TIMEOUT_MS  = 20_000; // generous timeout for slow endpoints
const CONCURRENCY       = 5;

class ModelHealthChecker {
  /**
   * @param {() => object} getCfg          - Returns the live config object
   * @param {object}       ipv4HttpAgent   - Shared IPv4-forced http.Agent
   * @param {object}       ipv4HttpsAgent  - Shared IPv4-forced https.Agent
   * @param {Function}     onConfigUpdated - Called with (updatedCfg) after health-driven config changes;
   *                                         caller should save + rebuild the pool.
   */
  constructor(getCfg, ipv4HttpAgent, ipv4HttpsAgent, onConfigUpdated = null) {
    this.getCfg          = getCfg;
    this.ipv4HttpAgent   = ipv4HttpAgent;
    this.ipv4HttpsAgent  = ipv4HttpsAgent;
    this.onConfigUpdated = onConfigUpdated;

    this.results     = {};    // key → { status, latencyMs, lastChecked, error, providerUrl, model }
    this.lastChecked = null;  // ISO string of last completed run
    this.nextCheck   = null;  // ISO string of scheduled next run
    this._timer      = null;
    this._running    = false;

    this._ensureDir();
    this._loadFromDisk();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(HEALTH_FILE)) {
        const raw        = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
        this.results     = raw.results     || {};
        this.lastChecked = raw.lastChecked || null;
        console.log(`[HealthChecker] Loaded ${Object.keys(this.results).length} cached health result(s) from disk`);
      }
    } catch (e) {
      console.warn('[HealthChecker] Could not load health file:', e.message);
    }
  }

  _saveToDisk() {
    try {
      fs.writeFileSync(
        HEALTH_FILE,
        JSON.stringify({ results: this.results, lastChecked: this.lastChecked }, null, 2),
        'utf8'
      );
    } catch (e) {
      console.warn('[HealthChecker] Could not save health file:', e.message);
    }
  }

  _key(providerUrl, model) {
    return `${providerUrl}::${model}`;
  }

  /** Send a minimal 1-token ping to a single model and return a result object. */
  async _checkModel(provider, model) {
    const cleanUrl     = (provider.url || '').replace(/\/$/, '');
    const providerType = provider.type || 'openai';
    const isEmbedding  = model.toLowerCase().includes('embed');
    const start        = Date.now();

    try {
      let response;

      if (providerType === 'anthropic') {
        // ── Anthropic native ──────────────────────────────────────────────
        response = await axios.post(
          `${cleanUrl}/messages`,
          { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
          {
            headers: {
              'x-api-key':         provider.key,
              'anthropic-version': '2023-06-01',
              'content-type':      'application/json',
            },
            timeout:        CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent:      this.ipv4HttpAgent,
            httpsAgent:     this.ipv4HttpsAgent,
          }
        );

      } else if (providerType === 'google') {
        // ── Google native ─────────────────────────────────────────────────
        const url = `${cleanUrl}/models/${model}:generateContent?key=${encodeURIComponent(provider.key)}`;
        response = await axios.post(
          url,
          {
            contents:         [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 },
          },
          {
            headers:        { 'content-type': 'application/json' },
            timeout:        CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent:      this.ipv4HttpAgent,
            httpsAgent:     this.ipv4HttpsAgent,
          }
        );

      } else if (isEmbedding) {
        // ── OpenAI-compatible embeddings ──────────────────────────────────
        response = await axios.post(
          `${cleanUrl}/embeddings`,
          { model, input: 'ping' },
          {
            headers:        { Authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
            timeout:        CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent:      this.ipv4HttpAgent,
            httpsAgent:     this.ipv4HttpsAgent,
          }
        );

      } else {
        // ── OpenAI-compatible chat ────────────────────────────────────────
        response = await axios.post(
          `${cleanUrl}/chat/completions`,
          { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
          {
            headers:        { Authorization: `Bearer ${provider.key}`, 'content-type': 'application/json' },
            timeout:        CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent:      this.ipv4HttpAgent,
            httpsAgent:     this.ipv4HttpsAgent,
          }
        );
      }

      const latencyMs = Date.now() - start;

      if (response.status === 200) {
        return {
          status:      latencyMs > SLOW_THRESHOLD_MS ? 'slow' : 'alive',
          latencyMs,
          lastChecked: new Date().toISOString(),
          error:       null,
        };
      }

      // Non-200 — extract a helpful error snippet
      let errMsg = `HTTP ${response.status}`;
      try {
        const body = response.data;
        if (body?.error?.message)       errMsg += `: ${String(body.error.message).slice(0, 120)}`;
        else if (body?.message)         errMsg += `: ${String(body.message).slice(0, 120)}`;
        else if (typeof body === 'string') errMsg += `: ${body.slice(0, 120)}`;
      } catch {}

      return { status: 'dead', latencyMs, lastChecked: new Date().toISOString(), error: errMsg };

    } catch (err) {
      const latencyMs = Date.now() - start;
      const errMsg = err.code === 'ECONNABORTED' ? 'Timeout' : err.message;
      return { status: 'dead', latencyMs, lastChecked: new Date().toISOString(), error: errMsg };
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Run a full health check across all enabled providers and their models.
   * Safe to call concurrently — a second call while one is running is a no-op.
   */
  async runCheck() {
    if (this._running) {
      console.log('[HealthChecker] Check already in progress — skipping duplicate call');
      return;
    }
    this._running = true;

    const cfg     = this.getCfg();

    // Parse the exclusions (comma separated list of partial matches)
    const excludes = (cfg.healthCheckExclude || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const isExcluded = (modelName) => {
      const mLower = modelName.toLowerCase();
      return excludes.some(pattern => mLower.includes(pattern));
    };

    // ── Deduplicate by URL: same endpoint = one check with the first enabled key.
    // Models from all providers sharing the same URL are merged (union).
    // This keeps the checker stealth — the endpoint only sees one probe per model.
    const urlMap = {}; // url → { provider, models: Set<string> }
    for (const provider of (cfg.providers || [])) {
      if (provider.enabled === false) continue;
      const url    = provider.url;
      const models = (provider.allowedModels && provider.allowedModels.length > 0)
        ? provider.allowedModels.map(m => (typeof m === 'object' ? m.name : m)).filter(Boolean)
        : (provider.cachedModels || []).map(String).filter(Boolean);

      if (!urlMap[url]) {
        // First key we see for this URL becomes the representative — used for auth
        urlMap[url] = { provider, models: new Set() };
      }
      // Merge models across all providers at the same URL (filtering out excluded models)
      for (const m of models) {
        if (!isExcluded(m)) {
          urlMap[url].models.add(m);
        }
      }
    }

    const tasks = [];
    for (const { provider, models } of Object.values(urlMap)) {
      for (const model of models) tasks.push({ provider, model });
    }

    const uniqueUrls = Object.keys(urlMap).length;

    if (tasks.length === 0) {
      console.log('[HealthChecker] No models to check — add providers with configured models in Settings');
      this.lastChecked = new Date().toISOString();
      this._saveToDisk();
      this._running = false;
      return;
    }

    console.log(`[HealthChecker] Checking ${tasks.length} model(s) across ${uniqueUrls} unique endpoint(s) (concurrency: ${CONCURRENCY})…`);

    // Process in batches to limit simultaneous outbound requests
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ provider, model }) => {
        const result  = await this._checkModel(provider, model);
        const key     = this._key(provider.url, model);
        const domain  = provider.url.replace(/^https?:\/\//, '').split('/')[0];
        this.results[key] = { ...result, providerUrl: provider.url, model };
        console.log(`[HealthChecker] ${domain} / ${model} → ${result.status} (${result.latencyMs}ms)`);
      }));
    }

    this.lastChecked = new Date().toISOString();
    this._saveToDisk();
    this._running = false;
    console.log(`[HealthChecker] ✅ Done. ${tasks.length} model(s) checked at ${this.lastChecked}`);

    // Auto-enable/disable models in config based on health results
    this._applyHealthToConfig();
  }

  /**
   * After each check, walk the live config and flip model `enabled` flags:
   *   dead  → enabled: false  (suppressed from routing)
   *   alive/slow → enabled removed (routing allowed)
   *
   * Excluded models are skipped from disabling. If they were previously disabled,
   * we re-enable them (remove enabled:false) to ensure they are routable.
   */
  _applyHealthToConfig() {
    if (!this.onConfigUpdated) return;

    const cfg     = this.getCfg();
    let   changed = false;

    // Parse the exclusions
    const excludes = (cfg.healthCheckExclude || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const isExcluded = (modelName) => {
      const mLower = modelName.toLowerCase();
      return excludes.some(pattern => mLower.includes(pattern));
    };

    // Clean up any legacy `enabled: false` fields in provider configurations to keep Option 1 clean
    for (const provider of (cfg.providers || [])) {
      if (!provider.allowedModels) continue;
      for (let i = 0; i < provider.allowedModels.length; i++) {
        const entry = provider.allowedModels[i];
        if (typeof entry === 'object' && 'enabled' in entry) {
          const { enabled: _removed, ...rest } = entry;
          provider.allowedModels[i] = rest;
          changed = true;
        }
      }
    }

    // Determine the status of each tested model
    // Group results by model
    const modelResults = {}; // modelName -> { alive: number, dead: number }
    for (const [key, result] of Object.entries(this.results)) {
      const { model, status } = result;
      if (!model || isExcluded(model)) continue;
      if (!modelResults[model]) {
        modelResults[model] = { alive: 0, dead: 0 };
      }
      if (status === 'dead') {
        modelResults[model].dead++;
      } else if (status === 'alive' || status === 'slow') {
        modelResults[model].alive++;
      }
    }

    // Load current disabledModels
    const currentDisabled = new Set(cfg.disabledModels || []);
    const nextDisabled = new Set(currentDisabled);

    for (const [model, counts] of Object.entries(modelResults)) {
      const totalChecks = counts.alive + counts.dead;
      if (totalChecks === 0) continue;

      const isDead = counts.dead > 0 && counts.alive === 0;
      const isAlive = counts.alive > 0;

      if (isDead && !nextDisabled.has(model)) {
        nextDisabled.add(model);
        changed = true;
        console.log(`[HealthChecker] ⛔ Globally disabled dead model: ${model}`);
      } else if (isAlive && nextDisabled.has(model)) {
        nextDisabled.delete(model);
        changed = true;
        console.log(`[HealthChecker] ✅ Globally re-enabled model: ${model}`);
      }
    }

    if (changed) {
      cfg.disabledModels = Array.from(nextDisabled);
      console.log('[HealthChecker] Updating config with new model health states…');
      this.onConfigUpdated(cfg);
    }
  }

  /**
   * Start the recurring health check timer.
   * Runs an immediate check on boot, then repeats every intervalMs.
   * @param {number} intervalMs  Default: 4 hours
   */
  start(intervalMs = 4 * 60 * 60 * 1000) {
    // Kick off initial check right away (async, non-blocking)
    this.nextCheck = new Date(Date.now() + intervalMs).toISOString();
    this.runCheck().catch(e => console.warn('[HealthChecker] Initial check error:', e.message));

    // Schedule recurring checks
    this._timer = setInterval(() => {
      this.nextCheck = new Date(Date.now() + intervalMs).toISOString();
      this.runCheck().catch(e => console.warn('[HealthChecker] Scheduled check error:', e.message));
    }, intervalMs);

    // Allow the process to exit cleanly even if this timer is pending
    if (this._timer.unref) this._timer.unref();

    console.log(`[HealthChecker] 🕐 Scheduled every ${intervalMs / 60_000} min. Next full check: ${this.nextCheck}`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Returns structured results ready for the dashboard API.
   * Groups models by provider, merges in latest cached results.
   */
  getResults() {
    const cfg    = this.getCfg();

    // Deduplicate by URL — same as runCheck() so the UI groups identically.
    // Multiple keys at the same endpoint are shown as one provider group.
    const urlMap = {}; // url → { provider, models: Set, keyCount }
    for (const provider of (cfg.providers || [])) {
      if (provider.enabled === false) continue;
      const url    = provider.url;
      const models = (provider.allowedModels && provider.allowedModels.length > 0)
        ? provider.allowedModels.map(m => (typeof m === 'object' ? m.name : m)).filter(Boolean)
        : (provider.cachedModels || []).map(String).filter(Boolean);

      if (!urlMap[url]) {
        urlMap[url] = { provider, models: new Set(), keyCount: 0 };
      }
      urlMap[url].keyCount++;
      for (const m of models) urlMap[url].models.add(m);
    }

    const providerGroups = Object.entries(urlMap).map(([url, { provider, models, keyCount }]) => {
      const domain = url.replace(/^https?:\/\//, '').split('/')[0];
      const modelList = [];
      for (const model of models) {
        const key    = this._key(url, model);
        const cached = this.results[key];
        modelList.push({
          model,
          status:      cached?.status      ?? 'unknown',
          latencyMs:   cached?.latencyMs   ?? null,
          lastChecked: cached?.lastChecked ?? null,
          error:       cached?.error       ?? null,
        });
      }
      // Sort: dead first, then slow, then alive, then unknown
      const order = { dead: 0, slow: 1, alive: 2, unknown: 3 };
      modelList.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
      return {
        url,
        domain,
        type:     provider.type || 'openai',
        keyCount, // how many API keys share this endpoint
        models:   modelList,
      };
    });

    return {
      providers:   providerGroups,
      lastChecked: this.lastChecked,
      nextCheck:   this.nextCheck,
      running:     this._running,
    };
  }
}

module.exports = ModelHealthChecker;
