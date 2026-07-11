'use strict';

/**
 * Model Health Checker
 *
 * Pings every configured model every 4 hours (or on-demand) with a minimal
 * 1-token request and classifies its response:
 *   - alive  : HTTP 200 within 5 000 ms
 *   - slow   : HTTP 200 but took > 5 000 ms
 *   - dead   : non-200, timeout, or network error
 *
 * Results are persisted to data/model_health.json and survive restarts.
 * Checks run with a concurrency limit of 5 to avoid hammering providers.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const HEALTH_FILE = path.join(DATA_DIR, 'model_health.json');
const HEALTH_HISTORY_FILE = path.join(DATA_DIR, 'model_health_history.jsonl');

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
    this.history     = [];    // Array of { timestamp, providerUrl, model, status, latencyMs }
    this.lastChecked = null;  // ISO string of last completed run
    this.nextCheck   = null;  // ISO string of scheduled next run
    this._timer      = null;
    this._running    = false;

    this._ensureDir();
    this._loadFromDisk();
    this._loadHistoryFromDisk();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  /** Check if a model name matches any exclusion pattern from config. */
  _isExcluded(modelName) {
    const cfg = this.getCfg();
    const excludes = (cfg.healthCheckExclude || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const mLower = modelName.toLowerCase();
    return excludes.some(pattern => mLower.includes(pattern));
  }

  _providerId(provider) {
    const digest = crypto.createHash('sha256')
      .update(String(provider.key || ''))
      .digest('hex')
      .slice(0, 16);
    return `${provider.url}::${digest}`;
  }

  _prepareRequest(url, provider, headers = {}) {
    const target = new URL(url);
    const nextHeaders = { ...headers };
    const type = provider.type || 'openai';

    if (type === 'anthropic') {
      nextHeaders['x-api-key'] = provider.key;
      nextHeaders['anthropic-version'] = nextHeaders['anthropic-version'] || '2023-06-01';
    } else if (type === 'google') {
      target.searchParams.set('key', provider.key);
    } else {
      const cfg = this.getCfg();
      if (cfg.keyInjectMode === 'query') {
        target.searchParams.set(cfg.keyInjectParam || 'api_key', provider.key);
      } else if (cfg.keyInjectMode === 'header') {
        nextHeaders[cfg.keyInjectHeader || 'X-API-Key'] = provider.key;
      } else {
        nextHeaders.Authorization = `Bearer ${provider.key}`;
      }
    }

    return { url: target.toString(), headers: nextHeaders };
  }


  /**
   * Build a deduplicated URL → { provider, models, keyCount } map from config.
   * Same endpoint = one entry; models from all providers sharing the URL are merged.
   */
  _buildUrlMap() {
    const cfg = this.getCfg();
    const urlMap = {}; // url → { provider, models: Set, keyCount }
    for (const provider of (cfg.providers || [])) {
      if (provider.enabled === false) continue;
      const url    = provider.url;
      const models = (provider.allowedModels && provider.allowedModels.length > 0)
        ? provider.allowedModels.map(m => (typeof m === 'object' ? m.name : m)).filter(Boolean)
        : (provider.cachedModels || []).map(String).filter(Boolean);

      if (!urlMap[url]) {
        urlMap[url] = { provider, providers: [], providerModels: new Map(), models: new Set(), keyCount: 0 };
      }
      urlMap[url].keyCount++;
      urlMap[url].providers.push(provider);
      urlMap[url].providerModels.set(this._providerId(provider), new Set(models.filter(m => !this._isExcluded(m))));
      for (const m of models) {
        if (!this._isExcluded(m)) {
          urlMap[url].models.add(m);
        }
      }
    }
    return urlMap;
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

  _loadHistoryFromDisk() {
    this.history = [];
    if (!fs.existsSync(HEALTH_HISTORY_FILE)) return;
    try {
      const raw = fs.readFileSync(HEALTH_HISTORY_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          this.history.push(e);
        } catch { /* skip bad line */ }
      }
      console.log(`[HealthChecker] Loaded ${this.history.length} health history entries from disk`);
      this._pruneHistory();
    } catch (e) {
      console.warn('[HealthChecker] Could not load health history:', e.message);
    }
  }

  _pruneHistory() {
    try {
      const cutoff = Date.now() - 90 * 86400_000; // 90 days
      const beforeCount = this.history.length;
      this.history = this.history.filter(h => new Date(h.timestamp).getTime() >= cutoff);
      const pruned = beforeCount - this.history.length;
      if (pruned > 0) {
        fs.writeFileSync(HEALTH_HISTORY_FILE, this.history.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        console.log(`[HealthChecker] Pruned ${pruned} old health history entries`);
      }
    } catch (e) {
      console.warn('[HealthChecker] Failed to prune health history:', e.message);
    }
  }

  _recordHistory(providerUrl, model, status, latencyMs, providerId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      providerUrl,
      providerId,
      model,
      status,
      latencyMs
    };
    this.history.push(entry);
    try {
      fs.appendFileSync(HEALTH_HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.warn('[HealthChecker] Could not append health history:', e.message);
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

  _key(providerOrUrl, model) {
    if (typeof providerOrUrl === 'string') return `${providerOrUrl}::${model}`;
    return `${this._providerId(providerOrUrl)}::${model}`;
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
        const request = this._prepareRequest(`${cleanUrl}/messages`, provider, { 'content-type': 'application/json' });
        response = await axios.post(
          request.url,
          { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
          {
            headers: request.headers,
            timeout: CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent: this.ipv4HttpAgent,
            httpsAgent: this.ipv4HttpsAgent,
          }
        );

      } else if (providerType === 'google') {
        // ── Google native ─────────────────────────────────────────────────
        const request = this._prepareRequest(`${cleanUrl}/models/${model}:generateContent`, provider, { 'content-type': 'application/json' });
        response = await axios.post(
          request.url,
          {
            contents:         [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 },
          },
          {
            headers: request.headers,
            timeout: CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent: this.ipv4HttpAgent,
            httpsAgent: this.ipv4HttpsAgent,
          }
        );

      } else if (isEmbedding) {
        // ── OpenAI-compatible embeddings ──────────────────────────────────
        const request = this._prepareRequest(`${cleanUrl}/embeddings`, provider, { 'content-type': 'application/json' });
        response = await axios.post(
          request.url,
          { model, input: 'ping' },
          {
            headers: request.headers,
            timeout:        CHECK_TIMEOUT_MS,
            validateStatus: () => true,
            httpAgent:      this.ipv4HttpAgent,
            httpsAgent:     this.ipv4HttpsAgent,
          }
        );

      } else {
        // ── OpenAI-compatible chat ────────────────────────────────────────
        const request = this._prepareRequest(`${cleanUrl}/chat/completions`, provider, { 'content-type': 'application/json' });
        response = await axios.post(
          request.url,
          { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
          {
            headers: request.headers,
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

    const urlMap = this._buildUrlMap();

    const tasks = [];
    for (const { providers, providerModels } of Object.values(urlMap)) {
      for (const provider of providers) {
        const models = providerModels.get(this._providerId(provider)) || [];
        for (const model of models) tasks.push({ provider, model });
      }
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
        const providerId = this._providerId(provider);
        const key     = this._key(provider, model);
        const domain  = provider.url.replace(/^https?:\/\//, '').split('/')[0];
        this.results[key] = { ...result, providerId, providerUrl: provider.url, model };
        this._recordHistory(provider.url, model, result.status, result.latencyMs, providerId);
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

    // Deep-clone config to avoid race conditions with concurrent dashboard saves (#10)
    const cfg     = JSON.parse(JSON.stringify(this.getCfg()));
    let   changed = false;

    const providerById = new Map(
      (cfg.providers || []).map(provider => [this._providerId(provider), provider])
    );
    const currentDisabled = new Set(cfg.disabledModels || []);
    const nextDisabled = new Set(currentDisabled);

    // Apply health state to the specific provider/key that was checked.
    for (const result of Object.values(this.results)) {
      const { model, status, providerId } = result;
      if (!model || !providerId || this._isExcluded(model)) continue;
      const provider = providerById.get(providerId);
      if (!provider) continue;

      const healthDisabled = new Set(provider.healthDisabledModels || []);
      const entry = (provider.allowedModels || []).find(e =>
        (typeof e === 'object' ? e.name : e) === model
      );
      const isDead = status === 'dead';
      const isAlive = status === 'alive' || status === 'slow';

      if (isDead) {
        if (!healthDisabled.has(model)) {
          healthDisabled.add(model);
          changed = true;
          console.log(`[HealthChecker] Disabled ${model} on ${provider.url}`);
        }
        if (entry && typeof entry === 'object' && entry.enabled !== false) {
          entry.enabled = false;
          changed = true;
        }
      } else if (isAlive) {
        if (healthDisabled.delete(model)) {
          changed = true;
          console.log(`[HealthChecker] Re-enabled ${model} on ${provider.url}`);
        }
        if (entry && typeof entry === 'object' && entry.enabled === false) {
          delete entry.enabled;
          changed = true;
        }
        // Clear legacy global health state when a current provider is alive.
        if (nextDisabled.delete(model)) changed = true;
      }

      provider.healthDisabledModels = Array.from(healthDisabled);
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
    const urlMap = this._buildUrlMap();
    const groups = new Map();

    for (const [url, group] of Object.entries(urlMap)) {
      if (!groups.has(url)) {
        groups.set(url, {
          url,
          domain: url.replace(/^https?:\/\//, '').split('/')[0],
          type: group.provider.type || 'openai',
          keyCount: 0,
          models: new Map(),
        });
      }

      const target = groups.get(url);
      target.keyCount += group.keyCount;
      for (const [providerId, models] of group.providerModels.entries()) {
        const provider = group.providers.find(candidate => this._providerId(candidate) === providerId);
        if (!provider) continue;
        for (const model of models) {
          if (!target.models.has(model)) target.models.set(model, []);
          target.models.get(model).push(provider);
        }
      }
    }

    const providers = Array.from(groups.values()).map(group => {
      const modelList = Array.from(group.models.entries()).map(([model, providerList]) => {
        const keyResults = providerList
          .map(provider => this.results[this._key(provider, model)])
          .filter(Boolean);
        const cachedResults = keyResults.length > 0 ? keyResults : (this.results[`${group.url}::${model}`] ? [this.results[`${group.url}::${model}`]] : []);
        const statuses = cachedResults.map(result => result.status);
        const status = statuses.includes('alive')
          ? 'alive'
          : statuses.includes('slow')
            ? 'slow'
            : statuses.length > 0 && statuses.every(value => value === 'dead')
              ? 'dead'
              : 'unknown';
        const latencyValues = cachedResults.map(result => result.latencyMs).filter(Number.isFinite);
        const deadResult = cachedResults.find(result => result.status === 'dead' && result.error);
        const modelHistory = this.history.filter(h => h.model === model && h.providerUrl === group.url);
        const totalChecks = modelHistory.length;
        const upChecks = modelHistory.filter(h => h.status === 'alive' || h.status === 'slow').length;

        return {
          model,
          status,
          latencyMs: latencyValues.length > 0 ? Math.min(...latencyValues) : null,
          lastChecked: cachedResults.reduce((latest, result) =>
            !latest || (result.lastChecked && result.lastChecked > latest) ? result.lastChecked : latest,
            null
          ),
          error: deadResult?.error || null,
          uptimePct: totalChecks > 0 ? Math.round((upChecks / totalChecks) * 100) : null,
          history: modelHistory.slice(-30).map(h => ({
            status: h.status,
            timestamp: h.timestamp,
            latencyMs: h.latencyMs,
          })),
        };
      });

      const order = { dead: 0, slow: 1, alive: 2, unknown: 3 };
      modelList.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
      return {
        url: group.url,
        domain: group.domain,
        type: group.type,
        keyCount: group.keyCount,
        models: modelList,
      };
    });

    return {
      providers,
      lastChecked: this.lastChecked,
      nextCheck: this.nextCheck,
      running: this._running,
    };
  }
}

module.exports = ModelHealthChecker;
