/**
 * API Key Router - Main Server
 *
 * Configuration is managed via the web UI at /dashboard (Settings tab).
 * Config is persisted to config.json and hot-reloaded without restart.
 * A secure proxy auth token is auto-generated on first run.
 *
 * Each entry in the pool is a provider: { url, key }
 * — different providers can have different base URLs.
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const http    = require('http');
const https   = require('https');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const dns     = require('dns');

// Prioritize IPv4 DNS resolution globally (Node.js v17+ defaults to verbatim which can resolve IPv6 first)
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

// Force IPv4 on all outbound requests — many VPS hosts have no IPv6 routing
const ipv4HttpAgent  = new http.Agent({ family: 4 });
const ipv4HttpsAgent = new https.Agent({ family: 4 });


const KeyPool       = require('./src/keyPool');
const RequestLogger = require('./src/requestLogger');
const configStore   = require('./src/configStore');
const { generateToken } = configStore;
const fmt = require('./src/formatConverter');
const fs = require('fs');
const pkg = require('./package.json');
const APP_VERSION = pkg.version || '1.0.0';
const { execSync } = require('child_process');
let GIT_COMMIT = '';
try {
  GIT_COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch (e) {
  GIT_COMMIT = '';
}


// ── Boot ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '51067', 10);

let cfg  = configStore.load();
let pool = buildPool(cfg);

function buildPool(c) {
  if (!c.providers || c.providers.length === 0) return null;
  return new KeyPool(c.providers, c.rotationThreshold, c.maxPerMinute, c.rotationIntervalMin, c.rotationMode, c.roundRobinSwitchLimit);
}

const reqLogger = new RequestLogger(200);

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const crypto = require('crypto');

// In-memory session store: token → { createdAt }
const activeDashboardTokens = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function isValidSession(token) {
  const sess = activeDashboardTokens.get(token);
  if (!sess) return false;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    activeDashboardTokens.delete(token);
    return false;
  }
  return true;
}


// ── Auth Middleware ────────────────────────────────────────────────────────
// Only the dashboard page itself and static assets are open — everything else requires auth
const OPEN_PREFIXES = ['/dashboard', '/stats'];

function authMiddleware(req, res, next) {
  const isOpen = OPEN_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'));
  if (isOpen) return next();

  if (req.path === '/login') return next();

  // Proxy requests — pick token based on endpoint
  if (req.path.startsWith('/proxy/') || req.path.startsWith('/v1/')) {
    const isAnthropic = req.path === '/v1/messages' || req.path === '/proxy/messages';
    const isGoogle    = req.path.startsWith('/v1/beta/') || req.path.startsWith('/proxy/beta/');

    const authHeader = req.headers['authorization'] || '';
    const match      = authHeader.match(/^Bearer\s+(.+)$/i);
    const provided   = match ? match[1] : req.headers['x-proxy-token'];

    const checkToken = (stored) => stored && provided &&
      provided.length === stored.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));

    let tokenOk = false;
    if (isAnthropic) {
      tokenOk = checkToken(cfg.anthropicProxyToken);
    } else if (isGoogle) {
      tokenOk = checkToken(cfg.googleProxyToken);
    } else {
      // OpenAI-compatible paths: accept openai token OR google token (Google clients use /v1/chat/completions)
      tokenOk = checkToken(cfg.proxyAuthToken) || checkToken(cfg.googleProxyToken);
    }

    if (!tokenOk && (cfg.proxyAuthToken || cfg.anthropicProxyToken || cfg.googleProxyToken)) {
      console.warn(`[Auth Warning] Unauthorized proxy request to ${req.path} from ${req.socket.remoteAddress}`);
      return res.status(401).json({ error: 'Unauthorized: invalid proxy token' });
    }
    return next();
  }

  // All other endpoints require a dashboard session token
  const authHeader = req.headers['authorization'] || '';
  const match      = authHeader.match(/^Bearer\s+(.+)$/i);
  const provided   = match ? match[1] : null;

  if (!provided || !isValidSession(provided)) {
    return res.status(401).json({ error: 'Unauthorized: invalid dashboard session' });
  }
  next();
}

app.use(authMiddleware);

// ── POST /login ────────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Missing username or password' });
  }

  const storedUsername = cfg.dashboardUsername || 'admin';
  const storedHash = cfg.dashboardPasswordHash;

  if (username === storedUsername && configStore.verifyPassword(password, storedHash)) {
    const token = crypto.randomBytes(32).toString('hex');
    activeDashboardTokens.set(token, { createdAt: Date.now() });
    return res.json({ ok: true, token });
  }

  res.status(401).json({ ok: false, error: 'Invalid username or password' });
});

// ── POST /change-password ──────────────────────────────────────────────────
app.post('/change-password', (req, res) => {
  const { username, currentPassword, newPassword } = req.body || {};
  if (!username || !currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'Missing username, current password, or new password' });
  }

  const storedHash = cfg.dashboardPasswordHash;

  if (configStore.verifyPassword(currentPassword, storedHash)) {
    const newHash = configStore.hashPassword(newPassword);
    cfg = configStore.save({
      ...cfg,
      dashboardUsername: username,
      dashboardPasswordHash: newHash
    });
    console.log(`[Auth] Credentials updated for user: ${username}`);
    return res.json({ ok: true });
  }

  res.status(401).json({ ok: false, error: 'Incorrect current password' });
});

// ── GET /config ────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  // Strip secrets: raw API keys and password hash are never sent to the client
  const safeProviders = (cfg.providers || []).map(p => ({
    url:           p.url,
    allowedModels: p.allowedModels,
    cachedModels:  p.cachedModels,
    keyHint:       p.key ? `...${p.key.slice(-6)}` : '',
  }));
  res.json({
    rotationThreshold: cfg.rotationThreshold,
    maxPerMinute:      cfg.maxPerMinute,
    rotationIntervalMin: cfg.rotationIntervalMin !== undefined ? cfg.rotationIntervalMin : 60,
    rotationMode:      cfg.rotationMode || 'time',
    roundRobinSwitchLimit: cfg.roundRobinSwitchLimit !== undefined ? cfg.roundRobinSwitchLimit : 1,
    keyInjectMode:     cfg.keyInjectMode,
    keyInjectParam:    cfg.keyInjectParam,
    keyInjectHeader:   cfg.keyInjectHeader,
    dashboardUsername: cfg.dashboardUsername,
    providerCount:     safeProviders.length,
    providers:         safeProviders,
    version:           APP_VERSION,
    commit:            GIT_COMMIT,
  });
});

// ── GET /config/full ───────────────────────────────────────────────────────
// Returns full config including keys (used internally by settings to populate table)
app.get('/config/full', (req, res) => {
  res.json({
    ...cfg,
    dashboardPasswordHash: undefined,
    providerCount: cfg.providers ? cfg.providers.length : 0,
    version:       APP_VERSION,
    commit:        GIT_COMMIT,
  });
});

const CONFIG_ALLOWED_KEYS = new Set([
  'rotationThreshold', 'maxPerMinute', 'keyInjectMode',
  'keyInjectParam', 'keyInjectHeader', 'providers', 'proxyAuthToken',
  'anthropicProxyToken', 'googleProxyToken', 'apiModes', 'rotationIntervalMin',
  'rotationMode', 'roundRobinSwitchLimit',
]);

// ── POST /config ───────────────────────────────────────────────────────────
app.post('/config', (req, res) => {
  try {
    // Allowlist: only accept known safe config keys, never accept credential fields
    const patch = {};
    for (const key of CONFIG_ALLOWED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        patch[key] = req.body[key];
      }
    }
    const saved = configStore.save({ ...cfg, ...patch });
    cfg  = saved;
    pool = buildPool(cfg);
    console.log(`[Config] Updated — ${cfg.providers.length} providers`);
    res.json({ ok: true, message: `Config saved. ${cfg.providers.length} providers loaded.`, providerCount: cfg.providers.length });
  } catch (err) {
    console.error('[Config] Save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /config/regenerate-token ──────────────────────────────────────────
const REGEN_ALLOWED = new Set(['proxyAuthToken', 'anthropicProxyToken', 'googleProxyToken']);
app.post('/config/regenerate-token', (req, res) => {
  const field = req.body?.field || 'proxyAuthToken';
  if (!REGEN_ALLOWED.has(field)) return res.status(400).json({ ok: false, error: 'Invalid token field' });
  const newToken = generateToken();
  cfg = configStore.save({ ...cfg, [field]: newToken });
  pool = buildPool(cfg);
  console.log(`[Config] ${field} regenerated`);
  res.json({ ok: true, field, token: newToken });
});

// ── GET /config/check-update ──────────────────────────────────────────────
// Checks if there are any new commits on origin/master compared to the local HEAD.
const { exec } = require('child_process');
app.get('/config/check-update', (req, res) => {
  const gitDir = path.join(__dirname, '.git');
  if (!fs.existsSync(gitDir)) {
    return res.json({ ok: false, available: false, error: 'Not running inside a Git repository.' });
  }

  exec('git fetch', (fetchErr) => {
    if (fetchErr) {
      console.warn('[Update Check] git fetch failed:', fetchErr.message);
      return res.json({ ok: false, available: false, error: 'Failed to fetch updates from GitHub: ' + fetchErr.message });
    }

    exec('git rev-list --count HEAD..origin/master', (diffErr, stdout) => {
      if (diffErr) {
        console.warn('[Update Check] git rev-list failed:', diffErr.message);
        return res.json({ ok: false, available: false, error: 'Failed to check commit difference: ' + diffErr.message });
      }

      const count = parseInt(stdout.trim(), 10) || 0;
      res.json({
        ok: true,
        available: count > 0,
        commitsBehind: count
      });
    });
  });
});

// ── POST /config/update ───────────────────────────────────────────────────
// Performs git pull and npm install to update the app, then exits to let PM2/systemd restart it.
app.post('/config/update', (req, res) => {
  const gitDir = path.join(__dirname, '.git');
  if (!fs.existsSync(gitDir)) {
    console.warn('[Update Warning] Blocked: Project is not running inside a Git repository (likely running in Docker).');
    return res.status(400).json({
      ok: false,
      error: 'In-app update is only supported when running directly from a Git clone (non-Docker). For Docker deployments, please use Watchtower or rebuild the image.'
    });
  }

  console.log('[System] Manual update triggered via dashboard settings...');
  
  exec('git pull && npm install --omit=dev', (err, stdout, stderr) => {
    if (err) {
      console.error('[Update Error] Git pull or npm install failed:', err.message);
      return res.status(500).json({
        ok: false,
        error: 'Update script failed: ' + err.message,
        log: stderr || err.message
      });
    }
    
    console.log('[Update Success] App updated. Output:\n', stdout);
    res.json({
      ok: true,
      message: 'Update successful! Exiting server to allow PM2/systemd to auto-restart the process.',
      log: stdout
    });

    // Exit process after a short delay so the response finishes sending
    setTimeout(() => {
      console.log('[System] Exiting process with code 1 to trigger PM2/systemd auto-restart...');
      process.exit(1);
    }, 1500);
  });
});

// Returns true only if the given url+key pair matches a configured provider.
// Prevents SSRF: dashboard endpoints that make outbound requests must use this guard.
function isConfiguredProvider(url, key) {
  const normalised = (url || '').trim().replace(/\/$/, '');
  return (cfg.providers || []).some(p => p.url === normalised && p.key === key);
}

// ── GET /provider/models ────────────────────────────────────────────────────────
// Fetches available models from a provider's /models endpoint.
// Used by the Settings UI to populate the model checklist.
app.post('/provider/models', async (req, res) => {
  const { url, key } = req.body || {};
  if (!url || !key) return res.status(400).json({ ok: false, error: 'Missing url or key' });
  if (!isConfiguredProvider(url, key)) return res.status(403).json({ ok: false, error: 'URL/key not in configured providers' });

  try {
    let modelsUrl = url.replace(/\/$/, '') + '/models';
    if (modelsUrl.includes('googleapis.com')) {
      // Google's OpenAI-compatible endpoint does not support /models, rewrite to native endpoint
      modelsUrl = modelsUrl.replace(/\/openai\/models$/, '/models');
    }

    let response = await axios.get(modelsUrl, {
      headers:        { 'Authorization': `Bearer ${key}` },
      validateStatus: () => true,
      timeout:        15_000,
      httpAgent:      ipv4HttpAgent,
      httpsAgent:     ipv4HttpsAgent,
    });

    // Google native API may reject bearer auth with 400 — retry with ?key= query param
    if (response.status === 400 && modelsUrl.includes('googleapis.com')) {
      const retryUrl = modelsUrl + (modelsUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
      const retry = await axios.get(retryUrl, { validateStatus: () => true, timeout: 15_000, httpAgent: ipv4HttpAgent, httpsAgent: ipv4HttpsAgent });
      if (retry.status === 200) response = retry;
    }

    if (response.status !== 200) {
      return res.json({ ok: false, error: `Provider returned HTTP ${response.status}`, raw: String(response.data).slice(0, 300) });
    }

    const data   = response.data;
    let   models = [];

    // OpenAI-compatible format: { data: [{id: ...}, ...] }
    if (Array.isArray(data?.data)) {
      models = data.data.map(m => m.id || m.name).filter(Boolean);
    }
    // Google native / some providers: { models: [{name: "models/gemini-...", ...}, ...] }
    else if (Array.isArray(data?.models)) {
      models = data.models.map(m => {
        const raw = typeof m === 'string' ? m : (m.id || m.name || '');
        return raw.replace(/^models\//, '');  // strip Google native "models/" prefix
      }).filter(Boolean);
    }
    // Fallback: plain array of strings
    else if (Array.isArray(data)) {
      models = data.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    }

    models.sort();
    res.json({ ok: true, models });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /provider/save-models ───────────────────────────────────────────────────────
// Saves model selections for a single provider without a full config save.
app.post('/provider/save-models', (req, res) => {
  const { index, allowedModels, cachedModels } = req.body || {};
  if (index === undefined || !Array.isArray(allowedModels)) {
    return res.status(400).json({ ok: false, error: 'Missing index or allowedModels' });
  }
  if (!cfg.providers[index]) {
    return res.status(404).json({ ok: false, error: 'Provider not found' });
  }

  cfg.providers[index].allowedModels = allowedModels;
  if (Array.isArray(cachedModels)) cfg.providers[index].cachedModels = cachedModels;
  cfg = configStore.save(cfg);
  pool = buildPool(cfg);
  const modelNames = allowedModels.map(m => typeof m === 'object' ? m.name : m);
  console.log(`[Models] Provider #${index+1}: ${modelNames.length ? modelNames.join(', ') : 'all models'}`);
  res.json({ ok: true });
});

// ── POST /provider/test-model ────────────────────────────────────────────────────────
// Tests if a specific model is alive on the provider's API.
app.post('/provider/test-model', async (req, res) => {
  const { url, key, model } = req.body || {};
  if (!url || !key || !model) {
    return res.status(400).json({ ok: false, error: 'Missing url, key, or model' });
  }
  if (!isConfiguredProvider(url, key)) return res.status(403).json({ ok: false, error: 'URL/key not in configured providers' });

  const cleanUrl = url.replace(/\/$/, '');
  const startTime = Date.now();
  const isEmbedding = model.toLowerCase().includes('embed');

  let targetUrl = `${cleanUrl}/chat/completions`;
  let data = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1
  };

  if (isEmbedding) {
    targetUrl = `${cleanUrl}/embeddings`;
    data = {
      model,
      input: 'ping'
    };
  }

  try {
    const response = await axios.post(targetUrl, data, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000,
      validateStatus: () => true,
      httpAgent: ipv4HttpAgent,
      httpsAgent: ipv4HttpsAgent,
    });

    const elapsed = Date.now() - startTime;

    // Fallback to /completions if chat/completions fails
    if (response.status !== 200 && !isEmbedding) {
      const fallbackUrl = `${cleanUrl}/completions`;
      const fallbackData = {
        model,
        prompt: 'ping',
        max_tokens: 1
      };
      
      try {
        const fallbackRes = await axios.post(fallbackUrl, fallbackData, {
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000,
          validateStatus: () => true,
          httpAgent: ipv4HttpAgent,
          httpsAgent: ipv4HttpsAgent,
        });
        
        if (fallbackRes.status === 200) {
          return res.json({ ok: true, elapsed: Date.now() - startTime });
        }
      } catch (e) {
        // ignore and let it return the original response
      }
    }

    if (response.status === 200) {
      return res.json({ ok: true, elapsed });
    } else {
      return res.json({ ok: false, error: `HTTP ${response.status}` });
    }
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});


// ── GET /status ────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  if (!pool) {
    return res.json({
      ok: false,
      configured: false,
      proxyAuthToken: cfg.proxyAuthToken,
      message: 'No providers configured. Open the Settings tab to add API keys.',
      server: { time: new Date().toISOString(), uptime: Math.floor(process.uptime()) },
    });
  }

  res.json({
    ok: true,
    configured: true,
    proxyAuthToken: cfg.proxyAuthToken,
    server: { time: new Date().toISOString(), uptime: Math.floor(process.uptime()) },
    pool: {
      totalProviders:          cfg.providers.length,
      totalRequestsLastMinute: pool.getTotalRequests(),
      effectiveCapacity:       (() => {
        const cap = cfg.providers
          .filter(p => p.enabled !== false)
          .reduce((s, p) => s + (p.rpm > 0 ? p.rpm : cfg.maxPerMinute), 0);
        return `${cap} req/min`;
      })(),
      rotationThreshold:       cfg.rotationThreshold,
      maxPerKey:               cfg.maxPerMinute,
      keys:                    pool.getStats(),
    },
    tokenStats: reqLogger.getTokenStats(),
  });
});

// ── GET /stats/summary ────────────────────────────────────────────────────
// Lightweight endpoint for external clients (e.g. Telegram bots).
// Auth: Bearer <dashboard session token> OR Bearer <proxyAuthToken>.
app.get('/stats/summary', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const match      = authHeader.match(/^Bearer\s+(.+)$/i);
  const provided   = match ? match[1] : null;

  const checkToken = (stored) => stored && provided &&
    provided.length === stored.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));

  const allowed = isValidSession(provided) ||
    checkToken(cfg.proxyAuthToken) ||
    checkToken(cfg.anthropicProxyToken) ||
    checkToken(cfg.googleProxyToken);

  if (!allowed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ts   = reqLogger.getTokenStats();
  const logs = reqLogger.getAll();

  // Avg latency from successful requests in the in-memory window
  let latSum = 0, latCount = 0;
  for (const e of logs) {
    if (e.responseTime && e.status >= 200 && e.status < 400) {
      latSum += e.responseTime;
      latCount++;
    }
  }
  const avgLatencyMs = latCount > 0 ? Math.round(latSum / latCount) : null;

  // Current RQM across all providers
  const currentRpm = pool ? pool.getTotalRequests() : 0;

  // Uptime
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const uptimeStr = h > 0
    ? `${h}h ${m}m ${s}s`
    : m > 0 ? `${m}m ${s}s` : `${s}s`;

  res.json({
    ok: true,
    uptime: uptimeStr,
    providers: {
      total:   cfg.providers ? cfg.providers.length : 0,
      enabled: cfg.providers ? cfg.providers.filter(p => p.enabled !== false).length : 0,
    },
    requests: {
      allTime:    ts.totalRequests,
      currentRpm: currentRpm,
    },
    tokens: {
      allTime:    ts.totalTokens,
      prompt:     ts.totalPrompt,
      completion: ts.totalCompletion,
    },
    latency: {
      avgMs:   avgLatencyMs,
      samples: latCount,
    },
  });
});

// ── GET /logs ──────────────────────────────────────────────────────────────
app.get('/logs', (req, res) => {
  const { from, to } = req.query;
  res.json(reqLogger.getAll(from || null, to || null));
});

// ── GET /dashboard ─────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── GET /v1/models ─────────────────────────────────────────────────────────
// Returns aggregated model list from enabled providers only.
app.get(['/v1/models', '/proxy/models'], (req, res) => {
  const seen = new Set();
  const models = [];
  for (const p of cfg.providers) {
    if (p.enabled === false) continue;
    // allowedModels takes priority; fall back to cachedModels
    const list = (p.allowedModels && p.allowedModels.length > 0)
      ? p.allowedModels
      : (p.cachedModels || []);
    for (const entry of list) {
      const modelName = typeof entry === 'object' ? entry.name : entry;
      if (!modelName) continue;
      if (!seen.has(modelName)) {
        seen.add(modelName);
        models.push({ id: modelName, object: 'model', created: 0, owned_by: 'router' });
      }
    }
  }
  res.json({ object: 'list', data: models });
});

// ── POST /v1/messages  (Anthropic-native endpoint for Claude CLI etc.) ───────
// Only active when apiModes.anthropic is enabled. Routes to anthropic-type providers.
app.post(['/v1/messages', '/proxy/messages'], (req, res, next) => {
  if (!cfg.apiModes?.anthropic) {
    return res.status(404).json({ error: 'Anthropic API mode is disabled. Enable it in Settings → API Modes.' });
  }
  // Tag request so proxy handler knows this is Anthropic-format input
  req._inputFormat   = 'anthropic';
  req._requiredType  = 'anthropic';
  next();
});

// ── ALL /proxy/* & /v1/* ───────────────────────────────────────────────────
app.all(['/proxy/*', '/v1/*'], async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      error: 'Not Configured',
      message: `No providers set. Open http://localhost:${PORT}/dashboard → Settings.`,
    });
  }

  const startTime = Date.now();
  const excludeSet = new Set();
  let attempts = 0;
  const maxAttempts = Math.min(3, cfg.providers.length);

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
  const clientUserAgent = req.headers['user-agent'] || 'unknown';
  const isMultipart = (req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data');

  // Capture request body payload string if present (up to 50,000 chars)
  let reqPayloadStr = '';
  if (isMultipart) {
    reqPayloadStr = '[multipart/form-data — binary file upload]';
  } else if (req.body && (req.method === 'POST' || req.method === 'PUT')) {
    try {
      reqPayloadStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
      if (reqPayloadStr.length > 50000) {
        reqPayloadStr = reqPayloadStr.slice(0, 50000) + '\n... [truncated for log size]';
      }
    } catch (e) {}
  }

  let requestedModel = null;
  if (req.body && typeof req.body === 'object' && req.body.model) {
    requestedModel = String(req.body.model);
  } else if (req.query.model) {
    // multipart/form-data requests can't be parsed yet — fall back to query param
    requestedModel = String(req.query.model);
  } else {
    // Try to extract from path for Google native API: /v1/beta/models/gemini-1.5-flash:generateContent
    const googleModelMatch = req.path.match(/\/(?:proxy|v1)\/(?:beta\/)?models\/([^:/]+)/);
    if (googleModelMatch) {
      requestedModel = googleModelMatch[1];
    }
  }


  const cleanPath = req.path.replace(/^\/(proxy|v1)/, '');
  if (['/props', '/slots', '/metrics'].includes(cleanPath)) {
    const responseTime = Date.now() - startTime;
    reqLogger.log({
      method: req.method,
      path: req.path,
      keyHint: '—',
      urlHint: '—',
      status: 404,
      responseTime,
      error: `Endpoint ${req.path} is not supported by this router.`,
      payload: reqPayloadStr,
      model: requestedModel,
      ip: clientIp,
      userAgent: clientUserAgent,
      tokens: null
    });
    return res.status(404).json({
      error: 'Not Found',
      message: `Endpoint ${req.path} is not supported by this router.`
    });
  }

  // Buffer raw multipart body once before retry loop so retries can resend it
  let rawMultipartBody = null;
  if (isMultipart && !['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase())) {
    rawMultipartBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  while (attempts < maxAttempts) {
    let provider = null;
    let keyHint = '?';
    try {
      const wantsStream  = req.body && typeof req.body === 'object' && req.body.stream === true;
      const inputFormat  = req._inputFormat  || 'openai';
      const requiredType = req._requiredType || null;

      provider = pool.getProvider(requestedModel, excludeSet, 0, requiredType);
      keyHint  = `...${provider.key.slice(-6)}`;

      const providerType = provider.type || 'openai';
      // needsConversion: client and provider speak different formats
      const needsConversion = inputFormat !== providerType;

      // ── Build URL ──────────────────────────────────────────────────────────
      const upstreamPath = req.path.replace(/^\/(proxy|v1)/, '');
      let urlObj;
      if (providerType === 'google') {
        const action = wantsStream ? 'streamGenerateContent' : 'generateContent';
        urlObj = new URL(`${provider.url.replace(/\/$/, '')}/models/${requestedModel || 'gemini-pro'}:${action}`);
        urlObj.searchParams.set('key', provider.key);
        if (wantsStream) urlObj.searchParams.set('alt', 'sse');
      } else {
        urlObj = new URL(`${provider.url}${upstreamPath}`);
        for (const [k, v] of Object.entries(req.query)) urlObj.searchParams.set(k, v);
      }

      // ── Headers ────────────────────────────────────────────────────────────
      const upstreamHeaders = { ...req.headers };
      delete upstreamHeaders['host'];
      delete upstreamHeaders['authorization'];
      delete upstreamHeaders['x-proxy-token'];
      delete upstreamHeaders['content-length'];

      if (providerType === 'anthropic') {
        upstreamHeaders['x-api-key']          = provider.key;
        upstreamHeaders['anthropic-version'] = upstreamHeaders['anthropic-version'] || '2023-06-01';
        // beta header for streaming requires it
        if (wantsStream) upstreamHeaders['anthropic-beta'] = upstreamHeaders['anthropic-beta'] || 'messages-2023-12-15';
      } else if (providerType === 'google') {
        // key injected as query param above — no auth header
      } else {
        if (cfg.keyInjectMode === 'query') {
          urlObj.searchParams.set(cfg.keyInjectParam, provider.key);
        } else if (cfg.keyInjectMode === 'header') {
          upstreamHeaders[cfg.keyInjectHeader] = provider.key;
        } else {
          upstreamHeaders['authorization'] = `Bearer ${provider.key}`;
        }
      }

      // ── Body preparation ───────────────────────────────────────────────────
      const isBodyMethod = !['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase());
      let bodyStr;
      if (isMultipart) {
        // Forward raw multipart body — preserve original content-type (includes boundary)
        upstreamHeaders['content-type']   = req.headers['content-type'];
        upstreamHeaders['content-length'] = rawMultipartBody ? rawMultipartBody.byteLength : 0;
      } else if (isBodyMethod && needsConversion && req.body) {
        if (inputFormat === 'openai' && providerType === 'anthropic') {
          bodyStr = JSON.stringify(fmt.openaiToAnthropic(req.body));
        } else if (inputFormat === 'openai' && providerType === 'google') {
          bodyStr = JSON.stringify(fmt.openaiToGoogle(req.body));
        } else {
          bodyStr = JSON.stringify(req.body);
        }
        upstreamHeaders['content-type']  = 'application/json';
        upstreamHeaders['content-length'] = Buffer.byteLength(bodyStr);
      } else if (isBodyMethod) {
        bodyStr = req.body ? JSON.stringify(req.body) : '';
        upstreamHeaders['content-type']  = 'application/json';
        upstreamHeaders['content-length'] = Buffer.byteLength(bodyStr);
      } else {
        // GET/HEAD/DELETE — strip any body headers so providers don't reject the request
        delete upstreamHeaders['content-type'];
        delete upstreamHeaders['content-length'];
      }

      pool.recordRequest(provider, requestedModel);

      // ── Streaming path ─────────────────────────────────────────────────────
      if (wantsStream && providerType !== 'google') {
        await new Promise((resolveStream, rejectStream) => {
          let settled = false;
          const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

          const transport = urlObj.protocol === 'https:' ? https : http;
          const proxyReq = transport.request(urlObj, {
            method: req.method,
            headers: upstreamHeaders,
            agent: urlObj.protocol === 'https:' ? ipv4HttpsAgent : ipv4HttpAgent,
          }, (proxyRes) => {
            const responseTime = Date.now() - startTime;

            if (proxyRes.statusCode >= 500 && attempts < maxAttempts - 1) {
              proxyRes.resume();
              return settle(rejectStream, new Error(`Upstream returned status ${proxyRes.statusCode}`));
            }

            if (proxyRes.statusCode >= 500 || proxyRes.statusCode === 401) {
              pool.recordFailure(provider);
            } else {
              pool.recordSuccess(provider);
            }

            const skipHeaders = new Set(['transfer-encoding','connection','keep-alive',
              'upgrade','proxy-authenticate','proxy-authorization','te','trailer']);
            const fwdHeaders = {};
            for (const [h, v] of Object.entries(proxyRes.headers)) {
              if (!skipHeaders.has(h.toLowerCase())) fwdHeaders[h] = v;
            }

            // When converting Anthropic SSE → OpenAI SSE, force content-type
            if (needsConversion && providerType === 'anthropic') {
              fwdHeaders['content-type'] = 'text/event-stream';
              delete fwdHeaders['content-length'];
            }
            res.writeHead(proxyRes.statusCode, fwdHeaders);

            const STREAM_BUF_LIMIT = 512 * 1024;
            const chunks = [];
            let streamBufLen = 0;
            let bufferCapped = false;
            let streamTokens = null;

            const onClientClose = () => { proxyReq.destroy(); proxyRes.destroy(); };
            req.once('close', onClientClose);

            if (needsConversion && providerType === 'anthropic') {
              // Convert Anthropic SSE → OpenAI SSE on the fly
              const sseState = { id: null, model: requestedModel, created: Math.floor(Date.now() / 1000) };
              let lineBuf = '';
              let curEvent = '';

              proxyRes.on('data', (chunk) => {
                lineBuf += chunk.toString('utf8');
                const lines = lineBuf.split('\n');
                lineBuf = lines.pop();
                for (const line of lines) {
                  const t = line.trimEnd();
                  if (t.startsWith('event:')) {
                    curEvent = t.slice(6).trim();
                  } else if (t.startsWith('data:')) {
                    const data = t.slice(5).trim();
                    const converted = fmt.anthropicSseToOpenaiSse(curEvent, data, sseState);
                    if (converted) res.write(converted);
                    // extract token usage
                    try {
                      const p = JSON.parse(data);
                      if (p.type === 'message_start' && p.message?.usage) {
                        streamTokens = { prompt: p.message.usage.input_tokens || 0, completion: 0, total: 0 };
                      }
                      if (p.type === 'message_delta' && p.usage) {
                        if (!streamTokens) streamTokens = { prompt: 0, completion: 0, total: 0 };
                        streamTokens.completion = p.usage.output_tokens || 0;
                        streamTokens.total = streamTokens.prompt + streamTokens.completion;
                      }
                    } catch {}
                    curEvent = '';
                  }
                }
              });

              proxyRes.on('error', (err) => { req.off('close', onClientClose); settle(rejectStream, err); });
              proxyRes.on('end', () => {
                req.off('close', onClientClose);
                if (streamTokens?.total > 0) pool.recordTokens(provider, streamTokens.total, requestedModel);
                try { reqLogger.log({ method: req.method, path: req.path, keyHint, urlHint: provider.url.replace(/^https?:\/\//, '').split('/')[0], status: proxyRes.statusCode, responseTime, payload: reqPayloadStr, model: requestedModel, ip: clientIp, userAgent: clientUserAgent, tokens: streamTokens }); } catch {}
                settle(resolveStream, true);
              });

            } else {
              // Pass-through (OpenAI provider or Anthropic→Anthropic)
              proxyRes.on('data', (chunk) => {
                if (!bufferCapped) {
                  streamBufLen += chunk.length;
                  if (streamBufLen <= STREAM_BUF_LIMIT) chunks.push(chunk);
                  else { bufferCapped = true; chunks.length = 0; }
                }
              });
              proxyRes.pipe(res);

              proxyRes.on('error', (err) => { req.off('close', onClientClose); settle(rejectStream, err); });
              proxyRes.on('end', () => {
                req.off('close', onClientClose);
                if (!bufferCapped) {
                  try {
                    const buf = Buffer.concat(chunks).toString('utf8');
                    const usageMatch = buf.match(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/);
                    if (usageMatch) {
                      const u = usageMatch[1];
                      const pm = u.match(/"prompt_tokens"\s*:\s*(\d+)/);
                      const cm = u.match(/"completion_tokens"\s*:\s*(\d+)/);
                      const tm = u.match(/"total_tokens"\s*:\s*(\d+)/);
                      if (pm || cm || tm) streamTokens = { prompt: pm ? parseInt(pm[1],10):0, completion: cm ? parseInt(cm[1],10):0, total: tm ? parseInt(tm[1],10):0 };
                    }
                  } catch {}
                }
                if (streamTokens?.total > 0) pool.recordTokens(provider, streamTokens.total, requestedModel);
                try { reqLogger.log({ method: req.method, path: req.path, keyHint, urlHint: provider.url.replace(/^https?:\/\//, '').split('/')[0], status: proxyRes.statusCode, responseTime, payload: reqPayloadStr, model: requestedModel, ip: clientIp, userAgent: clientUserAgent, tokens: streamTokens }); } catch {}
                settle(resolveStream, true);
              });
            }
          });

          proxyReq.setTimeout(120_000, () => proxyReq.destroy(new Error('Upstream request timed out')));
          proxyReq.on('error', (err) => { settle(rejectStream, err); });
          if (isMultipart && rawMultipartBody) {
            proxyReq.write(rawMultipartBody);
          } else if (!isMultipart) {
            proxyReq.write(bodyStr);
          }
          proxyReq.end();
        });
        return;
      }

      // ── Buffered path ──────────────────────────────────────────────────────
      const upstream = await axios({
        method:         req.method,
        url:            urlObj.toString(),
        headers:        upstreamHeaders,
        data:           !isBodyMethod ? undefined : (isMultipart ? rawMultipartBody : bodyStr),
        validateStatus: () => true,
        responseType:   'arraybuffer',
        timeout:        isMultipart ? 120_000 : 30_000,
        httpAgent:      ipv4HttpAgent,
        httpsAgent:     ipv4HttpsAgent,
      });

      if (upstream.status >= 500 && attempts < maxAttempts - 1) {
        throw new Error(`Upstream returned server error ${upstream.status}`);
      }

      if (upstream.status >= 500 || upstream.status === 401) {
        pool.recordFailure(provider);
      } else {
        pool.recordSuccess(provider);
      }

      const responseTime = Date.now() - startTime;

      const skipHeaders = new Set(['transfer-encoding','connection','keep-alive',
        'upgrade','proxy-authenticate','proxy-authorization','te','trailer']);
      for (const [h, v] of Object.entries(upstream.headers)) {
        if (!skipHeaders.has(h.toLowerCase())) res.setHeader(h, v);
      }

      let responseTokens = null;
      let sendData = Buffer.from(upstream.data);

      if (needsConversion && upstream.status < 400) {
        try {
          const resJson = JSON.parse(sendData.toString('utf8'));
          let converted;
          if (providerType === 'anthropic') converted = fmt.anthropicToOpenai(resJson);
          else if (providerType === 'google')    converted = fmt.googleToOpenai(resJson, requestedModel);
          if (converted) {
            sendData = Buffer.from(JSON.stringify(converted));
            res.setHeader('content-type', 'application/json');
            if (converted.usage) {
              responseTokens = { prompt: converted.usage.prompt_tokens || 0, completion: converted.usage.completion_tokens || 0, total: converted.usage.total_tokens || 0 };
            }
          }
        } catch {}
      } else {
        try {
          const resJson = JSON.parse(sendData.toString('utf8'));
          if (resJson?.usage) {
            responseTokens = { prompt: resJson.usage.prompt_tokens || 0, completion: resJson.usage.completion_tokens || 0, total: resJson.usage.total_tokens || 0 };
          }
        } catch {}
      }

      res.status(upstream.status).send(sendData);

      if (responseTokens?.total > 0) pool.recordTokens(provider, responseTokens.total, requestedModel);

      reqLogger.log({
        method: req.method, path: req.path, keyHint,
        urlHint: provider.url.replace(/^https?:\/\//, '').split('/')[0],
        status: upstream.status, responseTime, payload: reqPayloadStr,
        model: requestedModel, ip: clientIp, userAgent: clientUserAgent, tokens: responseTokens,
      });
      return;

    } catch (err) {
      attempts++;
      console.warn(`[Proxy Attempt ${attempts} Failed] Provider: ${provider ? provider.url : 'none'}, Error: ${err.message}`);

      if (provider) {
        excludeSet.add(`${provider.url}::${provider.key}`);
        pool.recordFailure(provider);
        reqLogger.log({
          method: req.method,
          path: req.path,
          keyHint,
          urlHint: provider.url.replace(/^https?:\/\//, '').split('/')[0],
          status: err.message.includes('status') ? parseInt(err.message.match(/\d+/)?.[0] || '502', 10) : 502,
          responseTime: Date.now() - startTime,
          error: `Attempt ${attempts} failed: ${err.message} (Failover active)`,
          payload: reqPayloadStr,
          model: requestedModel,
          ip: clientIp,
          userAgent: clientUserAgent,
          tokens: null
        });
      }

      if (attempts >= maxAttempts) {
        const responseTime = Date.now() - startTime;
        const isExhausted  = err.message === 'ALL_KEYS_EXHAUSTED';
        reqLogger.log({
          method: req.method,
          path: req.path,
          keyHint,
          status: isExhausted ? 429 : 502,
          responseTime,
          error: `All ${attempts} attempts failed. Last error: ${err.message}`,
          model: requestedModel,
          ip: clientIp,
          userAgent: clientUserAgent,
          tokens: null
        });

        if (isExhausted) {
          return res.status(429).json({ error: 'Too Many Requests', message: 'All providers exhausted. Retry in up to 60s.', retryAfter: 60 });
        }
        const noProvider = err.message?.startsWith('NO_PROVIDER_FOR_MODEL:');
        if (noProvider) {
          const model = err.message.split(':')[1];
          return res.status(404).json({ error: 'Model Not Found', message: `No provider configured for model '${model}'. Enable it in the Settings → Models.` });
        }
        return res.status(502).json({ error: 'Bad Gateway', message: `All ${attempts} failover attempts failed. Last error: ${err.message}` });
      }
    }
  }
});

// ── Catch-all ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path === '/' || req.path === '') return res.redirect('/dashboard');
  res.status(404).json({ error: 'Not Found' });
});

// ── Start ──────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✅ API Key Router running at http://localhost:${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard`);
  if (!cfg.providers || cfg.providers.length === 0) {
    console.log(`\n⚠️  No providers configured — open the dashboard and go to Settings!\n`);
  } else {
    console.log(`   Providers : ${cfg.providers.length} loaded`);
    const uniqueUrls = [...new Set(cfg.providers.map(p => p.url))];
    uniqueUrls.forEach(u => console.log(`             ${u}`));
    console.log();
  }
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n🛑 ${signal} received — shutting down gracefully…`);
  server.close(() => {
    console.log('   All connections closed. Bye!');
    process.exit(0);
  });
  // Force exit after 10s if connections won't close
  setTimeout(() => {
    console.warn('   Forcing exit after 10s timeout.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
