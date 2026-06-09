# API Key Router

A smart API key pool rotator with 24/7 provider pool rotation that lets your entire team share one endpoint while automatically rotating between multiple API keys to stay under rate limits.

## How It Works

```
Your Team
   │  (1 shared endpoint + 1 proxy token)
   ▼
API Router  ← picks best key → switches when near threshold
   │
   ▼
Upstream API  (e.g. https://api.example.com)
```

- **All providers are active 24/7**, rotating automatically across the entire pool
- Key rotation happens automatically at **32 req/min** (configurable threshold)
- Live dashboard at `/dashboard` shows real-time key health

---

## Setup

### 1. Install Dependencies
```powershell
cd "D:\Coding Projects\Personal\Router"
npm install
```

### 2. Configure via Dashboard
On first run, the server seeds its configuration from `.env` into `config.json`. After that, **all configuration is managed through the web dashboard**:

1. Copy `.env.example` to `.env` and fill in your initial values (proxy token, keys, etc.)
2. Start the server (`npm start`)
3. Open http://localhost:3000/dashboard → **Settings** tab
4. Add/remove providers, adjust thresholds, and change injection modes — all changes persist to `config.json` automatically

> **Note:** `.env` is only used for initial seeding on first run. Once `config.json` exists, the dashboard is the source of truth.

### 3. Run the Server
```powershell
npm start
# or for development with auto-reload:
npm run dev
```

Open http://localhost:3000/dashboard

---

## Using the Proxy (Your Team's Config)

Instead of calling the real API directly, your team calls the router:

**Before (direct):**
```
https://api.example.com/v1/endpoint?api_key=personal_key
```

**After (via router):**
```
http://your-server:3000/proxy/v1/endpoint
Authorization: Bearer your-shared-team-token
```

The router strips your proxy token, picks an appropriate upstream key, and forwards the request transparently.

---

## Key Injection Modes

Set `KEY_INJECT_MODE` in `.env`:

| Mode     | What it does                          | Example                         |
|----------|---------------------------------------|---------------------------------|
| `query`  | Adds key as URL query param (default) | `?api_key=KEY`                  |
| `header` | Adds custom header                    | `X-API-Key: KEY`                |
| `bearer` | Adds Authorization header             | `Authorization: Bearer KEY`     |

---

## API Endpoints

| Endpoint       | Description                              |
|----------------|------------------------------------------|
| `GET /dashboard` | Live monitoring UI                     |
| `GET /status`    | Full JSON status of all pools          |
| `GET /logs`      | Last 500 request log entries           |
| `ALL /proxy/*`   | Proxy to upstream (requires auth token)|

---

## Rotation Logic

1. The current key is used until its 60-second rolling window hits **threshold** (default: 32)
2. Router advances to the next key in the active pool
3. If ALL keys are exhausted (hit hard cap of 35/min), returns `HTTP 429` with `retryAfter: 60`
4. Keys auto-recover as their 60-second windows slide

---

## Environment Variables

> These are only used for **initial seeding** on first run. After that, use the dashboard Settings tab.

| Variable               | Default | Description                              |
|------------------------|---------|------------------------------------------|
| `PORT`                 | `3000`  | Server port                              |
| `PROXY_AUTH_TOKEN`     | —       | Your team's shared secret token          |
| `ROTATION_THRESHOLD`   | `32`    | Rotate key at this many req/min          |
| `MAX_REQUESTS_PER_MINUTE` | `35` | Hard cap per key                         |
| `KEY_INJECT_MODE`      | `query` | `query` / `header` / `bearer`            |
| `KEY_INJECT_PARAM`     | `api_key` | Query param name (if mode=query)       |
| `KEY_INJECT_HEADER`    | `X-API-Key` | Header name (if mode=header)         |
