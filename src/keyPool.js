/**
 * Key Pool
 * Tracks request counts per provider using a sliding 60-second window.
 * Supports per-provider AND per-model RPM/TPM limits.
 * allowedModels entries are { name, rpm, tpm } objects.
 */

const OFFLINE_THRESHOLD = 3;
const OFFLINE_RETRY_MS  = 60_000;

class KeyPool {
  constructor(providers, threshold = 32, maxPerMinute = 35, rotationIntervalMin = 60, rotationMode = 'time', roundRobinSwitchLimit = 1) {
    this.providers    = providers;
    this.threshold    = threshold;
    this.maxPerMinute = maxPerMinute;
    this.rotationIntervalMin = rotationIntervalMin;
    this.rotationMode = rotationMode;
    this.roundRobinSwitchLimit = roundRobinSwitchLimit;
    this.roundRobinRequestCount = 0;
    this.windows            = {};
    this.tokenWindows       = {};
    this.modelWindows       = {};  // `${provId}::${model}` → [timestamps]
    this.modelTokenWindows  = {};  // `${provId}::${model}` → [{ts,n}]
    this.currentIndex            = 0;
    this.lastRotationTime        = Date.now();
    this.consecutiveFailures     = {};
    this.lastFailureTime         = {};

    for (const p of providers) {
      const id = this._id(p);
      this.windows[id]      = [];
      this.tokenWindows[id] = [];
      this.consecutiveFailures[id] = 0;
      this.lastFailureTime[id]     = 0;
    }
  }

  // ── Internal ──────────────────────────────────────────────────

  _id(p)        { return `${p.url}::${p.key}`; }
  _modelId(p, model) { return `${this._id(p)}::${model}`; }

  _prune(p) {
    const id     = this._id(p);
    const cutoff = Date.now() - 60_000;
    this.windows[id] = (this.windows[id] || []).filter(ts => ts > cutoff);
  }

  _count(p) {
    this._prune(p);
    return (this.windows[this._id(p)] || []).length;
  }

  _pruneTokens(p) {
    const id     = this._id(p);
    const cutoff = Date.now() - 60_000;
    this.tokenWindows[id] = (this.tokenWindows[id] || []).filter(e => e.ts > cutoff);
  }

  _countTokens(p) {
    this._pruneTokens(p);
    return (this.tokenWindows[this._id(p)] || []).reduce((s, e) => s + e.n, 0);
  }

  // Resolve the allowedModels entry for a given model name
  _modelEntry(p, model) {
    if (!model || !p.allowedModels) return null;
    return p.allowedModels.find(e => (typeof e === 'object' ? e.name : e) === model) || null;
  }

  _modelRpm(p, model) {
    const e = this._modelEntry(p, model);
    return (e && typeof e === 'object' && e.rpm > 0) ? e.rpm : null;
  }

  _modelTpm(p, model) {
    const e = this._modelEntry(p, model);
    return (e && typeof e === 'object' && e.tpm > 0) ? e.tpm : null;
  }

  _countModel(p, model) {
    if (!model) return 0;
    const mid    = this._modelId(p, model);
    const cutoff = Date.now() - 60_000;
    this.modelWindows[mid] = (this.modelWindows[mid] || []).filter(ts => ts > cutoff);
    return this.modelWindows[mid].length;
  }

  _countModelTokens(p, model) {
    if (!model) return 0;
    const mid    = this._modelId(p, model);
    const cutoff = Date.now() - 60_000;
    this.modelTokenWindows[mid] = (this.modelTokenWindows[mid] || []).filter(e => e.ts > cutoff);
    return (this.modelTokenWindows[mid] || []).reduce((s, e) => s + e.n, 0);
  }

  _providerRpm(p) { return p.rpm || this.maxPerMinute; }

  _supportsModel(p, model) {
    if (!model) return true;
    const allowed = p.allowedModels;
    if (!allowed || allowed.length === 0) return true;
    return allowed.some(e => (typeof e === 'object' ? e.name : e) === model);
  }

  _isOffline(id) {
    const failures = this.consecutiveFailures[id] || 0;
    if (failures < OFFLINE_THRESHOLD) return false;
    if (Date.now() - (this.lastFailureTime[id] || 0) >= OFFLINE_RETRY_MS) return false;
    return true;
  }

  _isRateLimited(p, model) {
    const count  = this._count(p);
    const maxRpm = this._providerRpm(p);
    if (count >= maxRpm) return true;
    if (p.tpm && this._countTokens(p) >= p.tpm) return true;
    // Per-model limits
    const mRpm = this._modelRpm(p, model);
    if (mRpm && this._countModel(p, model) >= mRpm) return true;
    const mTpm = this._modelTpm(p, model);
    if (mTpm && this._countModelTokens(p, model) >= mTpm) return true;
    return false;
  }

  // ── Public API ────────────────────────────────────────────────

  getProvider(model = null, excludeSet = null, depth = 0, requiredType = null) {
    const total = this.providers.length;
    if (depth >= total) throw new Error('ALL_KEYS_EXHAUSTED');

    const anyEligible = this.providers.some(p =>
      p.enabled !== false &&
      (!requiredType || (p.type || 'openai') === requiredType) &&
      this._supportsModel(p, model) &&
      (!excludeSet || !excludeSet.has(this._id(p)))
    );
    if (!anyEligible) throw new Error(`NO_PROVIDER_FOR_MODEL:${model}`);

    // Trigger time-based rotation check at the start of selection (top-level invocation only)
    if (depth === 0 && this.rotationMode === 'time' && total > 1) {
      const elapsed = Date.now() - this.lastRotationTime;
      const intervalMs = this.rotationIntervalMin * 60_000;
      if (elapsed >= intervalMs) {
        this.currentIndex = (this.currentIndex + 1) % total;
        this.lastRotationTime = Date.now();
      }
    }

    // Pass 1: healthy (not offline) providers
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.currentIndex + attempt) % total;
      const p   = this.providers[idx];
      const id  = this._id(p);

      if (p.enabled === false) continue;
      if (requiredType && (p.type || 'openai') !== requiredType) continue;
      if (excludeSet && excludeSet.has(id)) continue;
      if (this._isOffline(id)) continue;
      if (!this._supportsModel(p, model)) continue;
      if (this._isRateLimited(p, model)) continue;

      const count = this._count(p);
      if (count >= this.threshold) {
        this.currentIndex = (this.currentIndex + 1) % total;
        this.lastRotationTime = Date.now();
        return this.getProvider(model, excludeSet, depth + 1, requiredType);
      }

      if (this.rotationMode === 'threshold' || this.rotationMode === 'time') {
        // Sticky behavior: stick to this provider, reset timer only on failover transition
        if (idx !== this.currentIndex) {
          this.currentIndex = idx;
          this.lastRotationTime = Date.now();
        }
      } else {
        // Round-robin
        if (idx !== this.currentIndex) {
          this.currentIndex = idx;
          this.roundRobinRequestCount = 1;
        } else {
          this.roundRobinRequestCount = (this.roundRobinRequestCount || 0) + 1;
        }

        if (this.roundRobinRequestCount >= this.roundRobinSwitchLimit) {
          if (this.rotationMode === 'random') {
            this.currentIndex = Math.floor(Math.random() * total);
          } else {
            this.currentIndex = (idx + 1) % total;
          }
          this.roundRobinRequestCount = 0;
        }
      }
      return p;
    }

    // Pass 2: include offline providers as fallback
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.currentIndex + attempt) % total;
      const p   = this.providers[idx];
      const id  = this._id(p);

      if (p.enabled === false) continue;
      if (requiredType && (p.type || 'openai') !== requiredType) continue;
      if (excludeSet && excludeSet.has(id)) continue;
      if (!this._supportsModel(p, model)) continue;
      if (!this._isRateLimited(p, model)) {
        if (this.rotationMode === 'threshold' || this.rotationMode === 'time') {
          if (idx !== this.currentIndex) {
            this.currentIndex = idx;
            this.lastRotationTime = Date.now();
          }
        } else {
          // Round-robin fallback
          if (idx !== this.currentIndex) {
            this.currentIndex = idx;
            this.roundRobinRequestCount = 1;
          } else {
            this.roundRobinRequestCount = (this.roundRobinRequestCount || 0) + 1;
          }

          if (this.roundRobinRequestCount >= this.roundRobinSwitchLimit) {
            if (this.rotationMode === 'random') {
              this.currentIndex = Math.floor(Math.random() * total);
            } else {
              this.currentIndex = (idx + 1) % total;
            }
            this.roundRobinRequestCount = 0;
          }
        }
        return p;
      }
    }

    throw new Error('ALL_KEYS_EXHAUSTED');
  }

  recordRequest(provider, model = null) {
    const id = this._id(provider);
    if (!this.windows[id]) this.windows[id] = [];
    this.windows[id].push(Date.now());

    if (model && this._modelRpm(provider, model)) {
      const mid = this._modelId(provider, model);
      if (!this.modelWindows[mid]) this.modelWindows[mid] = [];
      this.modelWindows[mid].push(Date.now());
    }
  }

  recordSuccess(provider) {
    this.consecutiveFailures[this._id(provider)] = 0;
  }

  recordFailure(provider) {
    const id = this._id(provider);
    this.consecutiveFailures[id] = (this.consecutiveFailures[id] || 0) + 1;
    this.lastFailureTime[id] = Date.now();
  }

  recordTokens(provider, count, model = null) {
    if (!count || count <= 0) return;
    const id = this._id(provider);
    if (!this.tokenWindows[id]) this.tokenWindows[id] = [];
    this.tokenWindows[id].push({ ts: Date.now(), n: count });

    if (model && this._modelTpm(provider, model)) {
      const mid = this._modelId(provider, model);
      if (!this.modelTokenWindows[mid]) this.modelTokenWindows[mid] = [];
      this.modelTokenWindows[mid].push({ ts: Date.now(), n: count });
    }
  }

  getStats() {
    return this.providers.map((p, idx) => {
      const count    = this._count(p);
      const id       = this._id(p);
      const domain   = p.url.replace(/^https?:\/\//, '').split('/')[0];
      const failures = this.consecutiveFailures[id] || 0;
      const maxRpm   = this._providerRpm(p);
      const tokens   = this._countTokens(p);

      return {
        index:               idx,
        keyHint:             `...${p.key.slice(-6)}`,
        urlHint:             domain,
        allowedModels:       p.allowedModels || [],
        cachedModels:        p.cachedModels  || [],
        modelLabel:          (p.allowedModels || []).length === 0
          ? ((p.cachedModels || []).length > 0 ? `All (${p.cachedModels.length})` : 'All')
          : `${p.allowedModels.length}${p.cachedModels.length > 0 ? '/' + p.cachedModels.length : ''} models`,
        requestsLastMinute:  count,
        threshold:           this.threshold,
        maxPerMinute:        maxRpm,
        rpm:                 p.rpm || null,
        tpm:                 p.tpm || null,
        tokensLastMinute:    tokens,
        isCurrent:           idx === this.currentIndex,
        consecutiveFailures: failures,
        enabled:             p.enabled !== false,
        status:
          p.enabled === false        ? 'disabled' :
          this._isOffline(id)        ? 'offline' :
          count >= maxRpm            ? 'exhausted' :
          (p.tpm && tokens >= p.tpm) ? 'exhausted' :
          count >= this.threshold    ? 'near-limit' : 'healthy',
      };
    });
  }

  getTotalRequests() {
    return this.providers.reduce((sum, p) => sum + this._count(p), 0);
  }
}

module.exports = KeyPool;
