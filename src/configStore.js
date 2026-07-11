/**
 * Config Store — persists router configuration to config.json.
 * Providers now include allowedModels and cachedModels per entry.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  proxyAuthToken:       '',
  anthropicProxyToken:  '',
  googleProxyToken:     '',
  rotationThreshold: 32,
  maxPerMinute:      35,
  rotationIntervalMin: 60,
  rotationMode:      'time',
  roundRobinSwitchLimit: 1,
  keyInjectMode:     'bearer',
  keyInjectParam:    'api_key',
  keyInjectHeader:   'X-API-Key',
  providers:         [],
  apiModes:          { openai: true, anthropic: false, google: false },
  disabledModels:    [],
  healthCheckInterval: 4, // in hours
  dashboardUsername: '',
  dashboardPasswordHash: '',
  port:              51067,
  httpsEnabled:      false,
  httpsCertPath:     '',
  httpsKeyPath:      '',
  healthCheckExclude: '',
  customModels:      [],
  customModelTimeoutMs: 5000,
};

function generateToken() {
  return 'rtr_' + crypto.randomBytes(20).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [_, salt, hash] = parts;
  const testBuf = crypto.scryptSync(password, salt, 64);
  const hashBuf = Buffer.from(hash, 'hex');
  if (testBuf.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(testBuf, hashBuf);
}

const VALID_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'google']);

function sanitizeModelEntry(m) {
  if (typeof m === 'string') return { name: m.trim(), rpm: null, tpm: null };
  if (m && typeof m === 'object' && m.name) {
    const rpm = parseInt(m.rpm, 10);
    const tpm = parseInt(m.tpm, 10);
    const entry = {
      name: String(m.name).trim(),
      rpm:  isFinite(rpm) && rpm > 0 ? rpm : null,
      tpm:  isFinite(tpm) && tpm > 0 ? tpm : null,
    };
    // Preserve health-checker-managed `enabled` flag if present
    if (m.enabled === false) entry.enabled = false;
    return entry;
  }
  return null;
}

function sanitizeProvider(p) {
  const rpm = parseInt(p.rpm, 10);
  const tpm = parseInt(p.tpm, 10);
  return {
    url:           (p.url  || '').trim().replace(/\/$/, ''),
    key:           (p.key  || '').trim(),
    allowedModels: Array.isArray(p.allowedModels)
      ? p.allowedModels.map(sanitizeModelEntry).filter(Boolean)
      : [],
    cachedModels:  Array.isArray(p.cachedModels)  ? p.cachedModels.map(String)  : [],
    rpm:           isFinite(rpm) && rpm > 0 ? rpm : null,
    tpm:           isFinite(tpm) && tpm > 0 ? tpm : null,
    enabled:       p.enabled !== false,
    type:          VALID_PROVIDER_TYPES.has(p.type) ? p.type : 'openai',
  };
}

function migrate(cfg) {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const baseUrl = (cfg.targetUrl || '').replace(/\/$/, '');
    cfg.providers = cfg.apiKeys
      .map(k => k.trim()).filter(Boolean)
      .map(key => sanitizeProvider({ url: baseUrl, key }));
    delete cfg.apiKeys;
    delete cfg.targetUrl;
    console.log(`[ConfigStore] Migrated ${cfg.providers.length} keys to providers format`);
  }
  return cfg;
}

function load() {
  let cfg;
  let isNew = false;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
      cfg = migrate(cfg);
    } catch (e) {
      const backupPath = CONFIG_PATH + '.bak.' + Date.now();
      try { fs.copyFileSync(CONFIG_PATH, backupPath); } catch (_) {}
      console.warn(`[ConfigStore] Failed to parse config.json — backed up to ${backupPath}, rebuilding from defaults…`);
    }
  }

  if (!cfg) {
    isNew = true;
    // Seed from .env
    const oldKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    const baseUrl = (process.env.TARGET_API_BASE_URL || '').replace(/\/$/, '');
    const seededPort = parseInt(process.env.PORT || '51067', 10);
    cfg = {
      ...DEFAULTS,
      proxyAuthToken:    process.env.PROXY_AUTH_TOKEN || generateToken(),
      rotationThreshold: parseInt(process.env.ROTATION_THRESHOLD      || '32', 10),
      maxPerMinute:      parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '35', 10),
      keyInjectMode:     process.env.KEY_INJECT_MODE  || 'bearer',
      keyInjectParam:    process.env.KEY_INJECT_PARAM || 'api_key',
      keyInjectHeader:   process.env.KEY_INJECT_HEADER|| 'X-API-Key',
      providers:         oldKeys.map(key => sanitizeProvider({ url: baseUrl, key })),
      port:              (seededPort >= 1 && seededPort <= 65535) ? seededPort : 51067,
    };
  }

  if (!cfg.proxyAuthToken)      { cfg.proxyAuthToken     = generateToken(); console.log('[ConfigStore] Auto-generated OpenAI proxy token'); }
  if (!cfg.anthropicProxyToken) { cfg.anthropicProxyToken = generateToken(); console.log('[ConfigStore] Auto-generated Anthropic proxy token'); }
  if (!cfg.googleProxyToken)    { cfg.googleProxyToken    = generateToken(); console.log('[ConfigStore] Auto-generated Google proxy token'); }

  // Ensure all providers have the new fields
  cfg.providers = (cfg.providers || []).map(sanitizeProvider).filter(p => p.url && p.key);

  cfg.disabledModels = Array.isArray(cfg.disabledModels) ? cfg.disabledModels.map(String) : [];
  cfg.healthCheckInterval = typeof cfg.healthCheckInterval === 'number' && cfg.healthCheckInterval > 0 ? cfg.healthCheckInterval : 4;

  cfg.customModels = Array.isArray(cfg.customModels)
    ? cfg.customModels.map(cm => {
        if (!cm || typeof cm !== 'object' || !cm.name) return null;
        return {
          name: String(cm.name).trim(),
          models: Array.isArray(cm.models) ? cm.models.map(String).map(s => s.trim()).filter(Boolean).slice(0, 20) : []
        };
      }).filter(Boolean)
    : [];

  cfg.customModelTimeoutMs = typeof cfg.customModelTimeoutMs === 'number' && cfg.customModelTimeoutMs > 0 ? cfg.customModelTimeoutMs : 5000;

  // Seed / generate dashboard credentials
  if (!cfg.dashboardUsername) {
    cfg.dashboardUsername = process.env.DASHBOARD_USERNAME || 'admin';
  }

  if (!cfg.dashboardPasswordHash) {
    const password = process.env.DASHBOARD_PASSWORD || 'xwitchr@)@^';
    cfg.dashboardPasswordHash = hashPassword(password);

    console.log('\n============================================================');
    console.log('🔒 DASHBOARD SECURITY INITIALIZATION');
    console.log(`Username: ${cfg.dashboardUsername}`);
    console.log(`Password: ${process.env.DASHBOARD_PASSWORD ? '(loaded from env)' : 'xwitchr@)@^ (default)'}`);
    console.log('============================================================\n');
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  if (isNew) {
    console.log('[ConfigStore] Created config.json');
  }
  return cfg;
}

function save(config) {
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // ignore
    }
  }

  let merged = { ...DEFAULTS, ...existing, ...config };
  merged = migrate(merged);
  merged.providers = (merged.providers || []).map(sanitizeProvider).filter(p => p.url && p.key);
  merged.rotationThreshold = parseInt(merged.rotationThreshold, 10) || 32;
  merged.maxPerMinute      = parseInt(merged.maxPerMinute,      10) || 35;
  merged.rotationIntervalMin = parseInt(merged.rotationIntervalMin, 10) >= 0 ? parseInt(merged.rotationIntervalMin, 10) : 60;
  merged.rotationMode      = ['time', 'round-robin', 'threshold', 'random'].includes(merged.rotationMode) ? merged.rotationMode : 'time';
  merged.roundRobinSwitchLimit = parseInt(merged.roundRobinSwitchLimit, 10) >= 1 ? parseInt(merged.roundRobinSwitchLimit, 10) : 1;
  if (!merged.proxyAuthToken)      merged.proxyAuthToken     = existing.proxyAuthToken     || generateToken();
  if (!merged.anthropicProxyToken) merged.anthropicProxyToken = existing.anthropicProxyToken || generateToken();
  if (!merged.googleProxyToken)    merged.googleProxyToken    = existing.googleProxyToken    || generateToken();
  if (!merged.apiModes || typeof merged.apiModes !== 'object') merged.apiModes = DEFAULTS.apiModes;
  merged.apiModes.openai = typeof merged.apiModes.openai === 'boolean' ? merged.apiModes.openai : true;
  const parsedPort = parseInt(merged.port, 10);
  merged.port = (parsedPort >= 1 && parsedPort <= 65535) ? parsedPort : 51067;
  merged.httpsEnabled  = !!merged.httpsEnabled;
  merged.httpsCertPath = String(merged.httpsCertPath || '').trim();
  merged.httpsKeyPath  = String(merged.httpsKeyPath  || '').trim();
  merged.disabledModels = Array.isArray(merged.disabledModels) ? merged.disabledModels.map(String) : (existing.disabledModels || []);
  merged.healthCheckInterval = typeof config.healthCheckInterval === 'number' && config.healthCheckInterval > 0 ? config.healthCheckInterval : 4;
  merged.customModels = Array.isArray(config.customModels)
    ? config.customModels.map(cm => {
        if (!cm || typeof cm !== 'object' || !cm.name) return null;
        return {
          name: String(cm.name).trim(),
          models: Array.isArray(cm.models) ? cm.models.map(String).map(s => s.trim()).filter(Boolean).slice(0, 20) : []
        };
      }).filter(Boolean)
    : (existing.customModels || []);
  merged.customModelTimeoutMs = typeof config.customModelTimeoutMs === 'number' && config.customModelTimeoutMs > 0 ? config.customModelTimeoutMs : 5000;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { load, save, generateToken, hashPassword, verifyPassword, CONFIG_PATH };
